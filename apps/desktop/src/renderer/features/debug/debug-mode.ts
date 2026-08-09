import { createExternalValue } from "@/renderer/lib/external-value";

/**
 * Debug mode — reveals the debug menu in the workspace header.
 *
 * Deliberately NOT persisted: it lives in memory for one run, so a launch is
 * always a clean slate and nobody has to discover why their header sprouted an
 * extra control weeks after flipping this once.
 */
const store = createExternalValue<boolean>(false);

export const getDebugMode = store.get;

export function useDebugMode(): [boolean, (next: boolean) => void] {
  return [store.useValue(), store.set];
}

/** Read-only binding for the surfaces that only need to know whether to show. */
export const useDebugModeEnabled = store.useValue;
