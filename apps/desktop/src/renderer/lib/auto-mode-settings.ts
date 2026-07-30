import { createPersistedValue } from "./external-value";

/**
 * Global "auto mode" preference, persisted to localStorage. When enabled,
 * Claude sessions are started with the `--permission-mode auto` flag.
 */

/** On by default — most sessions want auto mode. */
const DEFAULT_ENABLED = true;

const store = createPersistedValue<boolean>("plan.autoMode", (raw) =>
  typeof raw === "boolean" ? raw : DEFAULT_ENABLED,
);

/** Synchronous read for non-React callers. */
export const getAutoModeEnabled = store.get;

export const setAutoModeEnabled = store.set;

/** React binding for the settings UI and the command builder. */
export function useAutoModeEnabled(): [boolean, (next: boolean) => void] {
  return [store.useValue(), store.set];
}
