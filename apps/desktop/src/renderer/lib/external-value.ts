import { useSyncExternalStore } from "react";

/**
 * A module-scoped reactive value: synchronously readable outside React (module
 * code, notifiers, command builders) and subscribable from components via the
 * `useValue` hook. This is what the tiny settings stores share.
 *
 * Distinct from shared/lib/use-persisted-settings.ts, which is per-component
 * React state — use THIS when non-React code must read the value or several
 * mount points must stay in sync through one source of truth.
 */
export interface ExternalValue<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
  /** React binding. */
  useValue: () => T;
}

export function createExternalValue<T>(initial: T): ExternalValue<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  const get = () => current;
  const set = (next: T) => {
    current = next;
    listeners.forEach((l) => l());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const useValue = () => useSyncExternalStore(subscribe, get, get);

  return { get, set, subscribe, useValue };
}

/**
 * An ExternalValue persisted to localStorage. `revive` narrows whatever was
 * stored (untrusted: hand-edited, older build, corrupt) — it receives the
 * parsed JSON, or `undefined` when the key is absent or unreadable, and must
 * return a valid value either way. Writes are best-effort: quota/private-mode
 * failures keep the in-memory value for this run.
 */
export function createPersistedValue<T>(
  storageKey: string,
  revive: (raw: unknown) => T,
): ExternalValue<T> {
  const load = (): T => {
    try {
      const raw = localStorage.getItem(storageKey);
      return revive(raw === null ? undefined : JSON.parse(raw));
    } catch {
      return revive(undefined);
    }
  };

  const inner = createExternalValue<T>(load());
  const set = (next: T) => {
    inner.set(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Persistence is best-effort; the in-memory value still applies this run.
    }
  };

  return { ...inner, set };
}
