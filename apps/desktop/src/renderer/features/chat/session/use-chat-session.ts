import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedSession } from "@/common/shared-types";
import type { ChatEngineId } from "@/common/chat-engines";
import { chatTerminalId } from "@/common/terminal-ids";
import { useChatWorking } from "@/renderer/features/sessions/session-activity-store";
import { useSessionNeedsApproval } from "@/renderer/features/sessions/session-approval-store";
import { useAutoModeEnabled } from "./auto-mode-settings";
import {
  capabilitiesFor,
  useChatEngineCapabilities,
} from "./chat-engine-settings";
import {
  startChat,
  useChatEngineFor,
  useChatStarted,
} from "./chat-driver-store";
import { isNewSession } from "@/renderer/features/sessions/new-session-ids";
import { osNotify, pushToast } from "@/renderer/lib/toast-store";

/**
 * The selected chat session's lifecycle — everything between "there is a
 * selected session id" and the facts the workspace renders about it. Owns:
 *
 *  - the driver binding: whether the chat has a live engine behind it, which
 *    engine that is, and what that engine can do (see chat-engines.ts);
 *  - sending: composer submits and selector keystrokes, plus the send watchdog —
 *    the transcript is the delivery truth, so if no user message lands within
 *    12s of a send we say so instead of leaving the user lost;
 *  - activity signals, all observed facts (nothing invented): whether the agent
 *    is live, whether a turn is in flight, and whether it's waiting on you —
 *    with the auto-reveal of this workspace's own tab when it parks.
 *
 * Nothing here knows how any engine works. Starting Claude, delivering a
 * message, and deciding what "working" means all live behind the engine seam in
 * main; this hook consumes the normalized result.
 *
 * Cross-cutting UI moves (switch tab, open the dock) stay with the caller and
 * cross the seam as `revealChatTerminal`.
 */
export function useChatSession(opts: {
  encoded: string;
  selectedSessionId: string | null;
  /** The selected chat's parsed transcript — the watchdog's delivery truth. */
  session: ParsedSession | null;
  /** Mount the pane for a chat whose engine has a terminal to show. */
  ensureOpened: (tid: string) => void;
  /** Surface THIS workspace's chat terminal (tab + dock) — used by the
   *  stuck-message toast and the waiting-on-you auto-reveal. */
  revealChatTerminal: (sid: string) => void;
  /** The composer just submitted `/branch` for `fromSid`: its `claude` is about
   *  to fork into a new session id. `rootUuid` fingerprints the conversation
   *  (the branch copies it) so the caller can confirm which new transcript is
   *  the fork and follow the driver to it. Null root = can't fingerprint. */
  onBranchCommand?: (fromSid: string, rootUuid: string | null) => void;
}) {
  const {
    encoded,
    selectedSessionId,
    session,
    ensureOpened,
    revealChatTerminal,
    onBranchCommand,
  } = opts;
  const [globalAutoMode] = useAutoModeEnabled();

  // The selected chat's id, and whether anything is driving it. The dock (⌘J)
  // mirrors exactly this — it is never a plain shell.
  const chatId = selectedSessionId
    ? chatTerminalId(encoded, selectedSessionId)
    : null;
  const chatStarted = useChatStarted(chatId);
  const activeTerminalId = chatStarted ? chatId : null;
  /** Whether the selected chat has a live driver to send into. */
  const chatTerminalReady = chatStarted;

  // What the engine behind THIS chat supports. Null until the chat is started
  // (nothing is driving it, so there's nothing to describe) — callers gate on
  // an explicit capability rather than assuming a shape.
  const engineId: ChatEngineId | null = useChatEngineFor(chatId);
  const capabilities = useChatEngineCapabilities(engineId);

  /**
   * Start (or reattach to) the driver for ANY session in this project, in the
   * background — this does NOT reveal the dock. Enables the composer once main
   * confirms.
   *
   * Takes an explicit session id because the caller that needs it most — "new
   * chat" — mints an id and starts it in the same breath, before that session
   * is the selected one. This is the ONLY way a chat gets a driver: mounting a
   * pane doesn't start anything.
   *
   * Resolves true only when the chat ended up with a terminal pane mounted, so
   * a caller that wants to SHOW the dock can wait for something to actually be
   * there rather than opening it over nothing.
   */
  const startChatFor = useCallback(
    async (sid: string): Promise<boolean> => {
      const tid = chatTerminalId(encoded, sid);
      const res = await startChat(tid, {
        encoded,
        sessionId: sid,
        // A brand-new chat has no transcript yet, so it's started rather than
        // resumed; see new-session-ids.
        isNew: isNewSession(sid),
        autoMode: globalAutoMode,
      });
      if (res.error) {
        pushToast({
          title: "Couldn't start the session",
          description: res.error,
        });
        return false;
      }
      // Only an engine that actually has a terminal gets a pane.
      if (capabilitiesFor(res.engine)?.terminalPane !== true) return false;
      ensureOpened(tid);
      return true;
    },
    [encoded, globalAutoMode, ensureOpened],
  );

  /** `startChatFor` the currently selected session. */
  const connectChat = useCallback((): Promise<boolean> => {
    if (!selectedSessionId) return Promise.resolve(false);
    return startChatFor(selectedSessionId);
  }, [selectedSessionId, startChatFor]);

  // ── Send + watchdog ──────────────────────────────────────────
  // session in a ref so callbacks can read the latest without re-creating.
  const sessionRef = useRef<ParsedSession | null>(null);
  sessionRef.current = session;

  // Send watchdog: if no user message lands in the transcript within 12s of a
  // UI send, the message may be stuck — say so.
  const sendWatchdogRef = useRef<{
    baseLen: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const armSendWatchdog = useCallback(
    (sid: string) => {
      if (sendWatchdogRef.current) clearTimeout(sendWatchdogRef.current.timer);
      sendWatchdogRef.current = {
        baseLen: sessionRef.current?.messages.length ?? 0,
        timer: setTimeout(() => {
          sendWatchdogRef.current = null;
          pushToast({
            title: "Message may be stuck",
            description: "Please check the terminal.",
            actionLabel: "Open terminal",
            onAction: () => revealChatTerminal(sid),
          });
          if (!document.hasFocus())
            osNotify("plan", "Message may be stuck — check the terminal");
        }, 12_000),
      };
    },
    [revealChatTerminal],
  );

  // Chat composer: send a message into the selected chat's agent (submits).
  // No optimistic echo / "working" indicator — the transcript (JSONL watcher)
  // is the source of truth; the message appears when it actually lands.
  const sendChat = useCallback(
    (text: string, imagePaths: string[] = []) => {
      if (!selectedSessionId || !chatId || !chatStarted) return;

      // `/branch` forks this session into a NEW session id under the same
      // driver. Arm the follow BEFORE sending so the caller can rebind the tab
      // to the fork when its transcript appears. A branch lands no user message
      // in THIS transcript, so we must not arm the delivery watchdog (it would
      // cry "stuck") — we return right after sending.
      if (text.trim() === "/branch") {
        if (!capabilities?.branch) {
          pushToast({
            title: "Branching isn't available here",
            description:
              "The engine driving this session can't fork it into a new one.",
          });
          return;
        }
        const rootUuid =
          sessionRef.current?.messages.find((m) => m.uuid)?.uuid ?? null;
        onBranchCommand?.(selectedSessionId, rootUuid);
        window.electronAPI.sendToChat(chatId, text, imagePaths);
        return;
      }

      window.electronAPI.sendToChat(chatId, text, imagePaths);
      // The transcript will confirm delivery; if it doesn't within 12s, the
      // watchdog says so (toast + notification) instead of leaving you lost.
      armSendWatchdog(selectedSessionId);
    },
    [
      selectedSessionId,
      chatId,
      chatStarted,
      capabilities,
      armSendWatchdog,
      onBranchCommand,
    ],
  );

  // Answer an on-screen TUI selector (e.g. AskUserQuestion options) with
  // discrete keystrokes. Only engines driving a real TUI have one to type at;
  // for the rest there is nothing to send keys to, so we don't.
  const sendKeysToChat = useCallback(
    (keys: string[]) => {
      if (!chatId || !chatStarted || !capabilities?.keystrokes) return;
      window.electronAPI.sendKeysToChat(chatId, keys);
    },
    [chatId, chatStarted, capabilities],
  );

  // The transcript is the truth: a user message arriving clears the watchdog.
  useEffect(() => {
    const w = sendWatchdogRef.current;
    if (!w || !session) return;
    const delivered = session.messages
      .slice(w.baseLen)
      .some(
        (m) =>
          m.role === "user" && m.parts.some((p) => p.kind !== "tool_result"),
      );
    if (delivered) {
      clearTimeout(w.timer);
      sendWatchdogRef.current = null;
    }
  }, [session]);
  useEffect(() => {
    // Watchdog is per-session.
    if (sendWatchdogRef.current) {
      clearTimeout(sendWatchdogRef.current.timer);
      sendWatchdogRef.current = null;
    }
  }, [selectedSessionId]);

  // ── Activity signals (all observed facts — nothing invented) ──

  // Whether the agent itself is live and able to take a message. The engine
  // decides what that means for its own driver (a live `claude` among a pty's
  // descendants, an open protocol session); we only poll for the answer.
  const [agentLive, setAgentLive] = useState(false);
  useEffect(() => {
    if (!chatTerminalReady || !chatId) {
      setAgentLive(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let live = false;
      try {
        live = (await window.electronAPI.chatStatus(chatId)).agentLive;
      } catch {
        // Status unavailable — show the neutral state, not a wrong one.
        live = false;
      }
      if (!alive) return;
      setAgentLive(live);
      // Poll quickly until the agent is detected so the composer (which holds
      // send until then) unlocks right as the session finishes booting; ease
      // off to a slow heartbeat once it's up.
      timer = setTimeout(poll, live ? 5_000 : 1_000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [chatTerminalReady, chatId]);

  // Live "is a turn in flight right now" — an observed fact reported by the
  // engine, not a guess (see session-activity-store).
  const chatWorking = useChatWorking(activeTerminalId);

  // ── Waiting on you ───────────────────────────────────────────────────
  // From the approval store — the same fleet-wide signal that drives the
  // sidebar badges and the approval notifier. One signal, one source, instead
  // of a per-workspace poll. It wins over the "working" read: a session parked
  // on a prompt is still mid-turn, so `chatWorking` stays true the whole time
  // it waits.
  const awaitingSelection = useSessionNeedsApproval(activeTerminalId);

  // Auto-reveal the terminal when the session parks so the user can respond —
  // only once per transition into that state (not on every event). The
  // toast/OS banner is owned globally by the session-approval notifier (it
  // covers every session, including ones in projects/worktrees not on screen);
  // here we only do the local convenience of surfacing this workspace's own
  // tab, and only for an engine that has a terminal to surface.
  const autoRevealedRef = useRef(false);
  useEffect(() => {
    if (awaitingSelection && !autoRevealedRef.current) {
      autoRevealedRef.current = true;
      if (capabilities?.terminalPane) revealChatTerminal(selectedSessionId!);
    } else if (!awaitingSelection) {
      autoRevealedRef.current = false;
    }
  }, [awaitingSelection, selectedSessionId, capabilities, revealChatTerminal]);

  // Conversation turns (user messages that aren't tool results) — far more
  // meaningful than raw transcript entry count, and free to compute.
  const turnCount = useMemo(
    () =>
      session
        ? session.messages.filter(
            (m) =>
              m.role === "user" &&
              m.parts.some((p) => p.kind !== "tool_result"),
          ).length
        : 0,
    [session],
  );

  return {
    chatTerminalReady,
    activeTerminalId,
    /** What the engine behind this chat supports; null when nothing drives it. */
    capabilities,
    connectChat,
    startChatFor,
    sendChat,
    sendKeysToChat,
    agentLive,
    chatWorking,
    awaitingSelection,
    turnCount,
  };
}
