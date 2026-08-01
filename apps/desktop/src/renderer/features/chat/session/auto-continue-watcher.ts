import { useSyncExternalStore } from "react";
import {
  currentBusyIds,
  subscribeActivity,
} from "@/renderer/features/sessions/session-activity-store";
import { parseChatTerminalId } from "@/common/terminal-ids";
import { isRetryableApiError, recoveredAfter } from "@/common/api-errors";
import { getAutoContinueEnabled } from "./auto-continue-settings";

/**
 * Global "a session died mid-response — nudge it" watcher.
 *
 * Claude's request sometimes fails partway through a turn ("Connection closed
 * mid-response…"); the turn ends, the session parks, and it sits there until
 * someone types. This watches EVERY live chat session (module scope, started
 * once from the app root) and sends a single "Please continue" when that
 * happens.
 *
 * The trigger is the same signal behind the done-notifier: Claude's TUI shows
 * an `esc to interrupt` hint while a turn is in flight, so leaving the working
 * set means the turn ended. Only then do we look at the transcript — where the
 * failure is a structured field, not a guess (see api-errors).
 *
 * ONE retry per stuck point, never per session. After sending we mark the
 * session spent against that error's uuid, and re-arm only once a real
 * assistant turn lands past it — i.e. the nudge actually worked. So a flaky
 * connection that fails again hours later gets its own retry, while a nudge
 * that itself errors out stops dead instead of ping-ponging. The composer pill
 * takes over from there.
 *
 * Everything here is a re-checked live fact: busy state and the input-vs-menu
 * read are re-read after the settle delay, and if either call fails we send
 * nothing rather than type into a session we can't see.
 */

// After the working hint drops, re-confirm the session is really settled — the
// same insurance the done-notifier takes against a one-frame redraw blip.
const SETTLE_MS = 350;

/** The nudge itself. Deliberately plain: it has to read as a normal turn. */
export const CONTINUE_TEXT = "Please continue";

// Per chat: the uuid of the API error we already auto-continued. Memory
// only — after a restart the flip that would have fired is long past, so the
// worst case is a pill where there'd have been a silent retry.
const spentOn = new Map<string, string>();

// Chats we're in the middle of auto-continuing. The composer hides its pill
// for these so a retry we're already making doesn't flash a button at the user.
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function setInFlight(id: string, on: boolean) {
  if (on ? inFlight.has(id) : !inFlight.has(id)) return;
  if (on) inFlight.add(id);
  else inFlight.delete(id);
  for (const fn of listeners) fn();
}

function subscribeInFlight(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether an auto-continue is being sent for this chat right now. */
export function useAutoContinueInFlight(terminalId: string | null): boolean {
  return useSyncExternalStore(
    subscribeInFlight,
    () => (terminalId != null && inFlight.has(terminalId)) || false,
  );
}

let prevBusy = new Set<string>();
let unsub: (() => void) | null = null;
let unsubExit: (() => void) | null = null;

/**
 * A session's turn just ended. Decide whether it ended on a recoverable failure
 * that we haven't already retried, and if so send the nudge.
 */
async function onTurnEnded(id: string) {
  if (!getAutoContinueEnabled()) return;
  const parsed = parseChatTerminalId(id);
  if (!parsed) return;

  setInFlight(id, true);
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // Re-check the live facts rather than trusting the snapshot that woke us.
    // A failure to confirm is a reason to stay quiet, not to proceed.
    if ((await window.electronAPI.busyChatIds()).includes(id)) return;
    // Waiting on the user: "Please continue" would land ON the prompt and
    // answer it.
    if (await window.electronAPI.probeChatApproval(id)) return;

    // No cursor — we want the whole transcript, and passing one would disturb
    // the cursor the open chat tab keeps for this session.
    const res = await window.electronAPI.readSession(
      parsed.encoded,
      parsed.sessionId,
    );
    const messages = res?.messages;
    if (!messages || messages.length === 0) return;

    const last = messages[messages.length - 1];
    if (last.role !== "assistant" || !isRetryableApiError(last)) return;

    const spent = spentOn.get(id);
    if (spent) {
      // Same stuck point (or a nudge that errored straight out again) — leave
      // it. Only a turn that actually landed re-arms us.
      if (!recoveredAfter(messages, spent)) return;
      spentOn.delete(id);
    }

    spentOn.set(id, last.uuid);
    // The engine owns delivery; the transcript is what confirms it landed, so
    // we claim nothing here.
    window.electronAPI.sendToChat(id, CONTINUE_TEXT, []);
  } catch {
    // Couldn't read the session or confirm its state — send nothing.
  } finally {
    setInFlight(id, false);
  }
}

function tick() {
  const now = new Set(currentBusyIds());
  for (const id of prevBusy) {
    if (!now.has(id)) void onTurnEnded(id);
  }
  prevBusy = now;
}

/** Start the watcher. Idempotent; returns a stop function. */
export function startAutoContinueWatcher(): () => void {
  if (unsub) return stopAutoContinueWatcher;
  // An ended session drops out of the busy set the same way a finished turn
  // does — forget it on exit so we never nudge a session the user just ended.
  unsubExit = window.electronAPI.onChatExit((id) => {
    prevBusy.delete(id);
    spentOn.delete(id);
    setInFlight(id, false);
  });
  unsub = subscribeActivity(tick);
  return stopAutoContinueWatcher;
}

export function stopAutoContinueWatcher() {
  unsub?.();
  unsub = null;
  unsubExit?.();
  unsubExit = null;
  prevBusy = new Set();
}
