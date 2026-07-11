import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** New Set with `key` toggled — the expanded/collapsed-set updater:
 *  `setCollapsed(prev => toggleInSet(prev, key))`. */
export function toggleInSet<T>(prev: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Content equality for plain-JSON data (IPC payloads), for deduping refetched
 * state: `setX(prev => (sameJson(prev, next) ? prev : next))` keeps the old
 * identity so memoized children skip re-rendering when a poll/watcher tick
 * returned the same data. Compared by serialization, so it can only err toward
 * "different" (a key-order change forces a harmless refresh) — never toward
 * wrongly keeping stale state, and never silently missing a newly added field
 * the way a hand-written field list would.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
