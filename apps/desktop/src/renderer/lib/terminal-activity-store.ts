import { useSyncExternalStore } from "react";

/**
 * Live "is this terminal actively working" signal.
 *
 * The truth is Claude's rendered screen, not the output stream. While a turn is
 * in flight Claude's TUI shows an `esc to interrupt` hint and drops it the
 * instant the turn ends; main reads that off a headless emulator it keeps
 * current for every session (see terminal.ts `isTerminalBusy`). We poll that
 * here.
 *
 * Why not output timing (the previous approach): Claude runs with mouse tracking
 * on, so scrolling the terminal sends wheel escapes to the pty and Claude
 * repaints — a real, sustained output stream. "Any recent output = working" thus
 * read a 5-second scroll as 5 seconds of work and fired a bogus "done" the
 * moment you stopped. The screen hint can't be faked that way: scrolling slides
 * the viewport but never renders `esc to interrupt`.
 */

// Poll cadence. Main just scans its in-memory emulator rows, so this is a cheap
// invoke; 400ms keeps the working dot responsive without busy-spinning.
const POLL_MS = 400;

// Ids currently showing the working hint, as of the last poll.
let busy = new Set<string>();
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
  // Skip if a poll is still outstanding — never queue invokes up.
  if (inFlight) return;
  inFlight = true;
  try {
    const next = new Set(await window.electronAPI.terminalBusyIds());
    if (!setsEqual(next, busy)) {
      busy = next;
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
  busy = new Set();
}

function subscribe(listener: () => void) {
  ensureStarted();
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
