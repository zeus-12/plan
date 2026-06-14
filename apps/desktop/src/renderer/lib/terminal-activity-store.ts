import { useSyncExternalStore } from "react";

/**
 * Live "is this terminal actively working" signal, derived from the real
 * `terminal:data` stream that main pushes for every mounted pty — including the
 * hidden ones, since `openedIds` keeps connected chat terminals mounted.
 *
 * While Claude thinks / generates / runs a tool, its TUI spinner redraws
 * constantly (see main's terminal.ts output-coalescing note), so a steady run of
 * chunks arrives. The moment it returns to the idle prompt — or sits blocked on
 * an approval — output stops, and we decay to idle after WORKING_WINDOW_MS.
 *
 * This is an OBSERVED fact (real output from the process), not an optimistic
 * guess off a user action, so it's a sound basis for a "working" indicator.
 */

const WORKING_WINDOW_MS = 1500;
const TICK_MS = 400;

const lastDataAt = new Map<string, number>();
const listeners = new Set<() => void>();
let unsubData: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function ensureStarted() {
  if (unsubData) return;
  unsubData = window.electronAPI.onTerminalData((chunk) => {
    lastDataAt.set(chunk.id, Date.now());
    emit();
  });
  // Absence of data fires no event, so tick to let "working" decay to idle.
  ticker = setInterval(emit, TICK_MS);
}

function maybeStop() {
  if (listeners.size > 0) return;
  unsubData?.();
  unsubData = null;
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function subscribe(listener: () => void) {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    maybeStop();
  };
}

/** Whether terminal `id` emitted output within the working window. */
export function isWorking(id: string): boolean {
  const t = lastDataAt.get(id);
  return t !== undefined && Date.now() - t < WORKING_WINDOW_MS;
}

/** Milliseconds since terminal `id` last emitted output (Infinity if never). */
export function idleMs(id: string): number {
  const t = lastDataAt.get(id);
  return t === undefined ? Infinity : Date.now() - t;
}

/** Live "is this terminal actively emitting output" flag for a single id. */
export function useTerminalWorking(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? isWorking(id) : false),
    () => false,
  );
}
