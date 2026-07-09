import { useSyncExternalStore } from "react";
import { parseChatId } from "./session-notify";

/**
 * Live "which chat sessions are parked on an approval/selection menu" signal.
 *
 * The truth is Claude's rendered screen: an approval or plan/question menu draws
 * a numbered selector (or a footer like "Esc to cancel"), which main detects off
 * the headless emulator it keeps current for EVERY session — backgrounded ones
 * included. `awaitingSelectionIds` batches that scan (and gates it on a live
 * agent process) so we can surface "needs approval" for sessions that aren't the
 * one on screen. This store polls that and fans the result out to:
 *   - the notifier (toast + OS banner when a session newly parks), and
 *   - sidebar badges (which project / worktree / session is waiting on you).
 *
 * This mirrors terminal-activity-store (the "working" signal); the two are kept
 * separate because a session that's waiting on a menu still repaints its prompt,
 * so it reads as "working" the whole time the menu is up — the two states
 * coexist and must be tracked independently.
 */

// A menu stays up until the user answers it, so it doesn't need the 400ms
// cadence the working dot uses; a slightly slower poll keeps this cheap.
const POLL_MS = 700;

// Chat ids currently parked on a menu, as of the last poll. Only `chat:` ptys
// are Claude sessions; main can't emit a non-chat menu here, but we filter
// anyway so a stray scratch-shell TUI never raises an approval badge.
let awaiting = new Set<string>();
// The same set projected to target `encoded` cwds — rebuilt only when `awaiting`
// changes, so `useApprovalEncodedSet` gets a stable reference between polls
// (required by useSyncExternalStore to avoid an infinite render loop).
let awaitingEncoded = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit() {
  listeners.forEach((l) => l());
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    const ids = await window.electronAPI.terminalSelectionIds();
    const next = new Set(ids.filter((id) => id.startsWith("chat:")));
    if (!setsEqual(next, awaiting)) {
      awaiting = next;
      const encoded = new Set<string>();
      for (const id of next) {
        const parsed = parseChatId(id);
        if (parsed) encoded.add(parsed.encoded);
      }
      awaitingEncoded = encoded;
      emit();
    }
  } catch {
    // Main not ready / no terminals — leave the last known set in place.
  } finally {
    inFlight = false;
  }
}

function ensureStarted() {
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

function maybeStop() {
  if (listeners.size > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  awaiting = new Set();
  awaitingEncoded = new Set();
}

function subscribe(listener: () => void) {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    maybeStop();
  };
}

/** Subscribe to approval-set changes without binding to a single id. */
export function subscribeApproval(listener: () => void): () => void {
  return subscribe(listener);
}

/** Chat ids currently parked on an approval/selection menu (snapshot). */
export function currentApprovalIds(): string[] {
  return [...awaiting];
}

/** Live "is this session waiting on the user" flag for a single chat id. */
export function useSessionNeedsApproval(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? awaiting.has(id) : false),
    () => false,
  );
}

/**
 * The set of target `encoded` cwds (projects AND worktrees) that have at least
 * one session waiting on the user. The sidebar uses this to badge rows — a
 * project row rolls its own encoded plus its worktrees' encoded into one badge.
 */
export function useApprovalEncodedSet(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => awaitingEncoded,
    () => awaitingEncoded,
  );
}
