import { useSyncExternalStore } from "react";

/**
 * One app-wide minute clock. Relative labels ("5 mins ago") only change when
 * the wall clock crosses a minute boundary, so a single timer feeds every
 * label: they all flip together, and a label that has settled into an absolute
 * date sits the ticks out. The timer exists only while something subscribes.
 */

const MINUTE = 60_000;

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE);
}

let minute = currentMinute();
let timer: number | null = null;
let repeating = false;
const listeners = new Set<() => void>();

function tick(): void {
  const next = currentMinute();
  if (next === minute) return;
  minute = next;
  for (const listener of listeners) listener();
}

function start(): void {
  // Land on the next minute boundary, then repeat every 60s. Each tick re-reads
  // the clock, so a delayed timer — a hidden window Chromium throttled, a
  // machine back from sleep — corrects itself instead of drifting, and the
  // visibility/focus hooks pull that correction forward to the moment you look.
  repeating = false;
  timer = window.setTimeout(
    () => {
      tick();
      repeating = true;
      timer = window.setInterval(tick, MINUTE);
    },
    MINUTE - (Date.now() % MINUTE),
  );
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
}

function stop(): void {
  if (timer === null) return;
  if (repeating) window.clearInterval(timer);
  else window.clearTimeout(timer);
  timer = null;
  document.removeEventListener("visibilitychange", tick);
  window.removeEventListener("focus", tick);
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getSnapshot(): number {
  // With no timer running the cached minute may be stale, so re-read it — a
  // fresh mount then renders the current minute instead of waiting for a tick.
  // While the timer runs the cached value is returned untouched, which is what
  // useSyncExternalStore requires between notifications.
  if (timer === null) minute = currentMinute();
  return minute;
}

const noSubscribe = () => () => {};

/**
 * Re-render the caller on every minute boundary. Pass `active: false` for a
 * label that can no longer change — it then holds no subscription at all.
 */
export function useMinuteTick(active = true): void {
  useSyncExternalStore(
    active ? subscribe : noSubscribe,
    getSnapshot,
    getSnapshot,
  );
}
