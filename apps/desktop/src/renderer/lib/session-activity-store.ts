import { useSyncExternalStore } from "react";
import { parseChatTerminalId } from "../../terminal-ids";

/**
 * Live "is this chat session actively working" signal.
 *
 * The fact comes from whichever engine drives the session (see chat-engines.ts)
 * and arrives already normalized on `chat:activity`. For the terminal engine
 * that means Claude's rendered screen: while a turn is in flight its TUI shows
 * an `esc to interrupt` hint and drops it the instant the turn ends, read off a
 * headless emulator main keeps current for every session. Another engine may
 * know from its protocol instead. Either way what lands here is an observed
 * fact about a chat, not an inference from a user action.
 *
 * Event-fed, not polled: engines evaluate on change and push only CHANGES. One
 * snapshot fetch seeds the set on first subscribe; idle sessions cost nothing.
 *
 * Why not output timing (the original approach): Claude runs with mouse tracking
 * on, so scrolling the terminal sends wheel escapes to the pty and Claude
 * repaints — a real, sustained output stream. "Any recent output = working" thus
 * read a 5-second scroll as 5 seconds of work and fired a bogus "done" the
 * moment you stopped. The screen hint can't be faked that way: scrolling slides
 * the viewport but never renders `esc to interrupt`.
 */

// Chat ids currently working.
let busy = new Set<string>();
// Busy ids projected to their `encoded` cwd, so the sidebar can roll up a
// "Claude is working here" indicator per project/worktree. Rebuilt only when
// `busy` changes so the hook gets a stable reference between events.
let busyEncoded = new Set<string>();
const listeners = new Set<() => void>();
let offs: Array<() => void> | null = null;
// Ids touched by a live event while the initial snapshot was in flight — the
// event is fresher than the snapshot, so the snapshot must not override them.
let touchedDuringSeed: Set<string> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function rebuildEncoded() {
  const encoded = new Set<string>();
  for (const id of busy) {
    const parsed = parseChatTerminalId(id);
    if (parsed) encoded.add(parsed.encoded);
  }
  busyEncoded = encoded;
}

function setBusy(id: string, isBusy: boolean) {
  if (isBusy === busy.has(id)) return;
  busy = new Set(busy);
  if (isBusy) busy.add(id);
  else busy.delete(id);
  rebuildEncoded();
  emit();
}

function start() {
  if (offs) return;
  touchedDuringSeed = new Set();
  offs = [
    window.electronAPI.onChatActivity((id, activity) => {
      touchedDuringSeed?.add(id);
      setBusy(id, activity.busy);
    }),
    // An ended session leaves the set. Deferred a tick so every chat:exit
    // listener runs first — the done-notifier must prune the id from its
    // previous-busy set BEFORE it sees this store drop it, or a kill would
    // read as a finished turn.
    window.electronAPI.onChatExit((id) => {
      setTimeout(() => setBusy(id, false), 0);
    }),
  ];
  // Seed with the current fleet state; events arriving meanwhile win.
  void window.electronAPI
    .busyChatIds()
    .then((ids) => {
      if (!offs) return; // stopped while the snapshot was in flight
      const seeded = new Set(busy);
      for (const id of ids) {
        if (!touchedDuringSeed?.has(id)) seeded.add(id);
      }
      touchedDuringSeed = null;
      if (seeded.size !== busy.size) {
        busy = seeded;
        rebuildEncoded();
        emit();
      }
    })
    .catch(() => {
      // Main not ready / no sessions — events will fill the set in.
      touchedDuringSeed = null;
    });
}

function maybeStop() {
  if (listeners.size > 0) return;
  offs?.forEach((off) => off());
  offs = null;
  touchedDuringSeed = null;
  busy = new Set();
  busyEncoded = new Set();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    maybeStop();
  };
}

/**
 * Subscribe to working-state changes without binding to a single id — the
 * done-notifier diffs the whole busy set on each change.
 */
export function subscribeActivity(listener: () => void): () => void {
  return subscribe(listener);
}

/** Chat ids currently working (snapshot). */
export function currentBusyIds(): string[] {
  return [...busy];
}

/** Whether chat `id` is currently working. */
export function isWorking(id: string): boolean {
  return busy.has(id);
}

/** Live "is this chat actively working" flag for a single id. */
export function useChatWorking(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? isWorking(id) : false),
    () => false,
  );
}

/**
 * The set of target `encoded` cwds (projects AND worktrees) with at least one
 * chat session actively working. The sidebar rolls this up the same way it does
 * the approval / unread sets.
 */
export function useWorkingEncodedSet(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => busyEncoded,
    () => busyEncoded,
  );
}
