import { useSyncExternalStore } from "react";

/**
 * Global "auto mode" preference, persisted to localStorage. When enabled,
 * Claude sessions are started with the `--permission-mode auto` flag. A per-project
 * default (see project-defaults-modal) can still override this for a specific
 * project; this is the app-wide fallback used when a project hasn't set its own.
 *
 * Tiny external store (same shape as notification-settings) so the value can be
 * read synchronously outside React and kept in sync with the settings UI.
 */

const STORAGE_KEY = "plan.autoMode";

/** On by default — most sessions want auto mode. */
const DEFAULT_ENABLED = true;

let enabled: boolean = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw != null) return JSON.parse(raw) === true;
  } catch {
    // Corrupt/unavailable storage — fall back to the default, never crash.
  }
  return DEFAULT_ENABLED;
}

/** Synchronous read for non-React callers. */
export function getAutoModeEnabled(): boolean {
  return enabled;
}

export function setAutoModeEnabled(next: boolean) {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is best-effort; the in-memory value still applies this run.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the settings UI and the command builder. */
export function useAutoModeEnabled(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    getAutoModeEnabled,
    getAutoModeEnabled,
  );
  return [value, setAutoModeEnabled];
}
