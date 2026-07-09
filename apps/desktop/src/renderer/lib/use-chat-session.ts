import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedSession, TerminalInputState } from "../../shared-types";
import { chatTerminalId, chatTerminalPrefix } from "../../terminal-ids";
import { useTerminalWorking } from "./terminal-activity-store";
import { useAutoModeEnabled } from "./auto-mode-settings";
import { isNewSession } from "./new-session-ids";
import { osNotify, pushToast } from "./toast-store";

/**
 * The selected chat session's lifecycle — everything between "there is a
 * selected session id" and the facts the workspace renders about it. Owns:
 *
 *  - the terminal binding: whether the chat's Claude pty is live, its id
 *    (the dock mirrors it), and the `claude --resume` / `--session-id`
 *    startup command;
 *  - sending: composer submits and TUI keystrokes, plus the send watchdog —
 *    the transcript is the delivery truth, so if no user message lands within
 *    12s of a send we say so instead of leaving the user lost;
 *  - activity signals, all observed facts (nothing invented): the agent
 *    process name polled from the pty, "actively emitting output" from the
 *    screen hint, and the input-vs-selection-menu read of the rendered TUI —
 *    with the auto-reveal of this workspace's own tab when a menu appears.
 *
 * Cross-cutting UI moves (switch tab, open the dock) stay with the caller and
 * cross the seam as `revealChatTerminal`.
 */
export function useChatSession(opts: {
  encoded: string;
  selectedSessionId: string | null;
  /** The selected chat's parsed transcript — the watchdog's delivery truth. */
  session: ParsedSession | null;
  /** Terminal registry bits (see useTerminalRegistry). */
  openedIds: string[];
  ensureOpened: (tid: string) => void;
  sendToTerminal: (
    tid: string,
    text: string,
    imagePaths: string[],
    submit: boolean,
  ) => void;
  /** Surface THIS workspace's chat terminal (tab + dock) — used by the
   *  stuck-message toast and the selection-menu auto-reveal. */
  revealChatTerminal: (sid: string) => void;
}) {
  const {
    encoded,
    selectedSessionId,
    session,
    openedIds,
    ensureOpened,
    sendToTerminal,
    revealChatTerminal,
  } = opts;
  const chatPrefix = chatTerminalPrefix(encoded);
  const [globalAutoMode] = useAutoModeEnabled();

  // The selected chat's pty id, when its terminal has been opened. The dock
  // (⌘J) mirrors exactly this — it is never a plain shell.
  const sessionResumed =
    selectedSessionId != null &&
    openedIds.includes(chatTerminalId(encoded, selectedSessionId));
  const activeTerminalId = sessionResumed
    ? chatTerminalId(encoded, selectedSessionId!)
    : null;
  /** Whether the selected chat has a live (resumed) terminal to send into. */
  const chatTerminalReady = sessionResumed;

  /** Startup command for a chat pty: brand-new chats start claude with a
   *  pre-chosen session id (nothing to resume yet); existing ones resume. */
  const initialCommandFor = useCallback(
    (tid: string): string | undefined => {
      if (!tid.startsWith(chatPrefix)) return undefined;
      const sid = tid.slice(chatPrefix.length);
      const flags = globalAutoMode ? " --permission-mode auto" : "";
      return isNewSession(sid)
        ? `claude --session-id ${sid}${flags}`
        : `claude --resume ${sid}${flags}`;
    },
    [chatPrefix, globalAutoMode],
  );

  /** Start `claude --resume` for the selected session in the background
   *  (does NOT reveal the dock). Enables the composer. */
  const connectChat = useCallback(() => {
    if (!selectedSessionId) return;
    ensureOpened(chatTerminalId(encoded, selectedSessionId));
  }, [selectedSessionId, encoded, ensureOpened]);

  // ── Send + watchdog ──────────────────────────────────────────
  // session in a ref so callbacks can read the latest without re-creating.
  const sessionRef = useRef<ParsedSession | null>(null);
  sessionRef.current = session;

  // Send watchdog: if no user message lands in the transcript within 12s of a
  // UI send, the message may be stuck behind a TUI prompt — say so.
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

  // Chat composer: send a message into the selected chat's `claude` (submits).
  // No optimistic echo / "working" indicator — the transcript (JSONL watcher)
  // is the source of truth; the message appears when it actually lands.
  const sendChat = useCallback(
    (text: string, imagePaths: string[] = []) => {
      if (!selectedSessionId) return;
      const tid = chatTerminalId(encoded, selectedSessionId);
      if (!openedIds.includes(tid)) return;
      sendToTerminal(tid, text, imagePaths, true);
      // The transcript will confirm delivery; if it doesn't within 12s, the
      // watchdog says so (toast + notification) instead of leaving you lost.
      armSendWatchdog(selectedSessionId);
    },
    [selectedSessionId, encoded, openedIds, sendToTerminal, armSendWatchdog],
  );

  // Drive the chat terminal's TUI selectors (e.g. AskUserQuestion options)
  // with discrete keystrokes.
  const sendKeysToChat = useCallback(
    (keys: string[]) => {
      if (!selectedSessionId) return;
      const tid = chatTerminalId(encoded, selectedSessionId);
      if (!openedIds.includes(tid)) return;
      window.electronAPI.terminalSendKeys(tid, keys);
    },
    [selectedSessionId, encoded, openedIds],
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

  // ── Activity signals (all transcript/OS facts — nothing invented) ──

  // Agent status: poll the pty's foreground process name (an OS fact) so the
  // header can say whether Claude itself is running in the chat terminal.
  const [agentProcess, setAgentProcess] = useState<string | null>(null);
  useEffect(() => {
    if (!chatTerminalReady || !selectedSessionId) {
      setAgentProcess(null);
      return;
    }
    const tid = chatTerminalId(encoded, selectedSessionId);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let proc: string | null = null;
      try {
        const st = await window.electronAPI.terminalStatus(tid);
        proc = st.running ? st.process : null;
        if (alive) setAgentProcess(proc);
      } catch {
        // Status unavailable — show the neutral state, not a wrong one.
        if (alive) setAgentProcess(null);
      }
      if (!alive) return;
      // Poll quickly until Claude is detected so the composer (which holds send
      // until the agent is live) unlocks right as the session finishes booting;
      // ease off to a slow heartbeat once it's up.
      const live = /claude|node/i.test(proc ?? "");
      timer = setTimeout(poll, live ? 5_000 : 1_000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [chatTerminalReady, selectedSessionId, encoded]);
  // Claude's CLI runs under node; either name means the agent process is live.
  const agentLive = /claude|node/i.test(agentProcess ?? "");

  // Live "is Claude actively emitting output right now" — an observed fact from
  // the pty stream, not a guess. The spinner redraws while it works, so output
  // flowing = working; output stopped = idle (done or blocked on approval).
  const chatWorking = useTerminalWorking(
    selectedSessionId ? chatTerminalId(encoded, selectedSessionId) : null,
  );

  // ── Input-box vs. selection-menu detection ───────────────────────────
  // Heuristic read of the chat terminal's rendered screen (a headless emulator
  // in main scans the bottom rows for Claude's TUI box). "selection" means a
  // numbered approval/plan/question menu is up — there's NO free-text box, so
  // sending a message + Enter would mis-navigate the menu.
  const [inputState, setInputState] = useState<TerminalInputState>("unknown");
  useEffect(() => {
    if (!chatTerminalReady || !selectedSessionId) {
      setInputState("unknown");
      return;
    }
    const tid = chatTerminalId(encoded, selectedSessionId);
    let alive = true;
    const poll = async () => {
      try {
        const res = await window.electronAPI.terminalInputState(tid);
        if (!alive) return;
        setInputState(res.state);
      } catch {
        if (alive) setInputState("unknown");
      }
    };
    void poll();
    const interval = setInterval(poll, 1_500);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [chatTerminalReady, selectedSessionId, encoded]);

  // A rendered selection menu IS the "waiting for you" signal — it must win
  // over the output-recency "working" heuristic, NOT be gated by it: Claude
  // keeps repainting the prompt (cursor blink / box redraw) while it waits, so
  // `chatWorking` stays true the whole time the menu is up. We only require the
  // agent process to be live (a stray menu in a dead shell isn't actionable).
  const awaitingSelection = agentLive && inputState === "selection";

  // Auto-reveal the terminal when a menu appears so the user can respond —
  // only once per transition into the selection state (not on every poll). The
  // toast/OS banner is owned globally by the session-approval notifier (it
  // covers every session, including ones in projects/worktrees not on screen);
  // here we only do the local convenience of surfacing this workspace's own tab.
  const autoRevealedRef = useRef(false);
  useEffect(() => {
    if (awaitingSelection && !autoRevealedRef.current) {
      autoRevealedRef.current = true;
      revealChatTerminal(selectedSessionId!);
    } else if (!awaitingSelection) {
      autoRevealedRef.current = false;
    }
  }, [awaitingSelection, selectedSessionId, revealChatTerminal]);

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
    initialCommandFor,
    connectChat,
    sendChat,
    sendKeysToChat,
    agentLive,
    chatWorking,
    awaitingSelection,
    turnCount,
  };
}
