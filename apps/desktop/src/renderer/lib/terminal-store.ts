import { useCallback, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * Terminal dock view-state keyed by project `encoded`. Lives at module scope so
 * it survives `ProjectWorkspace` remounts (the workspace is keyed by `encoded`,
 * so without this the open terminals — including resumed chats — would vanish
 * every time you switch projects, forcing a re-resume). The ptys themselves
 * already persist in the main process; this keeps the renderer's view of them.
 */
interface TerminalState {
  /** Terminal ids that have been opened (kept mounted, hidden when inactive). */
  openedIds: string[];
  /** Whether the dock is currently shown. */
  open: boolean;
  /** Dock height in px. */
  height: number;
}

const DEFAULT: TerminalState = { openedIds: [], open: false, height: 300 };

const store = new Map<string, TerminalState>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function get(encoded: string): TerminalState {
  return store.get(encoded) ?? DEFAULT;
}

function makeSetter<K extends keyof TerminalState>(
  encoded: string,
  key: K
): Dispatch<SetStateAction<TerminalState[K]>> {
  return (update) => {
    const cur = get(encoded);
    const next =
      typeof update === "function"
        ? (update as (p: TerminalState[K]) => TerminalState[K])(cur[key])
        : update;
    if (next === cur[key]) return;
    store.set(encoded, { ...cur, [key]: next });
    emit();
  };
}

export function useProjectTerminals(encoded: string): {
  openedIds: string[];
  setOpenedIds: Dispatch<SetStateAction<string[]>>;
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  terminalHeight: number;
  setTerminalHeight: Dispatch<SetStateAction<number>>;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded)
  );

  const setOpenedIds = useCallback(makeSetter(encoded, "openedIds"), [encoded]);
  const setTerminalOpen = useCallback(makeSetter(encoded, "open"), [encoded]);
  const setTerminalHeight = useCallback(
    makeSetter(encoded, "height"),
    [encoded]
  );

  return {
    openedIds: snapshot.openedIds,
    setOpenedIds,
    terminalOpen: snapshot.open,
    setTerminalOpen,
    terminalHeight: snapshot.height,
    setTerminalHeight,
  };
}
