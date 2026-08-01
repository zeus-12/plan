import { createPersistedValue } from "@/renderer/lib/external-value";

/**
 * "Auto-continue on error" preference, persisted to localStorage.
 *
 * It governs the SILENT retry only — the watcher sending "Please continue" by
 * itself when a live session drops a transient API error. The composer's
 * continue pill is not gated on it: the pill sends nothing until you click it,
 * so there's no behaviour to opt out of.
 *
 * Off by default — the app should not type into your sessions until you ask it
 * to.
 */

const DEFAULT_ENABLED = false;

const store = createPersistedValue<boolean>("plan.autoContinue", (raw) =>
  typeof raw === "boolean" ? raw : DEFAULT_ENABLED,
);

/** Synchronous read for the watcher (not a React caller). */
export const getAutoContinueEnabled = store.get;

export const setAutoContinueEnabled = store.set;

/** React binding for the settings UI. */
export function useAutoContinueEnabled(): [boolean, (next: boolean) => void] {
  return [store.useValue(), store.set];
}
