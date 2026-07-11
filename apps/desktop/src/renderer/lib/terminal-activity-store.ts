import { useSyncExternalStore } from "react";

/**
 * Live "is this terminal actively working" signal.
 *
 * The truth is Claude's rendered screen, not the output stream. While a turn is
 * in flight Claude's TUI shows an `esc to interrupt` hint and drops it the
 * instant the turn ends; main reads that off a headless emulator it keeps
 * current for every session (see tui-screen.ts).
 *
 * Event-fed, not polled: a state change can only follow pty output, so main
 * evaluates after each output burst and pushes only CHANGES over
 * `terminal:activity`. One snapshot fetch seeds the set on first subscribe;
 * idle sessions cost nothing after that.
 *
 * Why not output timing (the previous approach): Claude runs with mouse tracking
 * on, so scrolling the terminal sends wheel escapes to the pty and Claude
 * repaints — a real, sustained output stream. "Any recent output = working" thus
 * read a 5-second scroll as 5 seconds of work and fired a bogus "done" the
 * moment you stopped. The screen hint can't be faked that way: scrolling slides
 * the viewport but never renders `esc to interrupt`.
 */

// Ids currently showing the working hint.
let busy = new Set<string>();
const listeners = new Set<() => void>();
let offs: Array<() => void> | null = null;
// Ids touched by a live event while the initial snapshot was in flight — the
// event is fresher than the snapshot, so the snapshot must not override them.
let touchedDuringSeed: Set<string> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function setBusy(id: string, isBusy: boolean) {
  if (isBusy === busy.has(id)) return;
  busy = new Set(busy);
  if (isBusy) busy.add(id);
  else busy.delete(id);
  emit();
}

function start() {
  if (offs) return;
  touchedDuringSeed = new Set();
  offs = [
    window.electronAPI.onTerminalActivity((id, activity) => {
      touchedDuringSeed?.add(id);
      setBusy(id, activity.busy);
    }),
    // A killed pty leaves the set. Deferred a tick so every terminal:exit
    // listener runs first — the done-notifier must prune the id from its
    // previous-busy set BEFORE it sees this store drop it, or a kill would
    // read as a finished turn.
    window.electronAPI.onTerminalExit((id) => {
      setTimeout(() => setBusy(id, false), 0);
    }),
  ];
  // Seed with the current fleet state; events arriving meanwhile win.
  void window.electronAPI
    .terminalBusyIds()
    .then((ids) => {
      if (!offs) return; // stopped while the snapshot was in flight
      const seeded = new Set(busy);
      for (const id of ids) {
        if (!touchedDuringSeed?.has(id)) seeded.add(id);
      }
      touchedDuringSeed = null;
      if (seeded.size !== busy.size) {
        busy = seeded;
        emit();
      }
    })
    .catch(() => {
      // Main not ready / no terminals — events will fill the set in.
      touchedDuringSeed = null;
    });
}

function maybeStop() {
  if (listeners.size > 0) return;
  offs?.forEach((off) => off());
  offs = null;
  touchedDuringSeed = null;
  busy = new Set();
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

/** Ids currently showing the working hint (snapshot). */
export function currentBusyIds(): string[] {
  return [...busy];
}

/** Whether terminal `id` is currently showing the working hint. */
export function isWorking(id: string): boolean {
  return busy.has(id);
}

/** Live "is this terminal actively working" flag for a single id. */
export function useTerminalWorking(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? isWorking(id) : false),
    () => false,
  );
}
