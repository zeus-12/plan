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
