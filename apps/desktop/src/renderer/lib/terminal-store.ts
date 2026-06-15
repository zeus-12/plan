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
  /** Scratch shells (`term:<encoded>:<n>`), in sidebar order. */
  shells: string[];
  /** Shell shown in the sidebar's embedded terminal pane. */
  activeShellId: string | null;
}

const DEFAULT: TerminalState = {
  openedIds: [],
  open: false,
  shells: [],
  activeShellId: null,
};

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
  shells: string[];
  setShells: Dispatch<SetStateAction<string[]>>;
  activeShellId: string | null;
  setActiveShellId: Dispatch<SetStateAction<string | null>>;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded)
  );

  const setOpenedIds = useCallback(makeSetter(encoded, "openedIds"), [encoded]);
  const setTerminalOpen = useCallback(makeSetter(encoded, "open"), [encoded]);
  const setShells = useCallback(makeSetter(encoded, "shells"), [encoded]);
  const setActiveShellId = useCallback(
    makeSetter(encoded, "activeShellId"),
    [encoded]
  );

  return {
    openedIds: snapshot.openedIds,
    setOpenedIds,
    terminalOpen: snapshot.open,
    setTerminalOpen,
    shells: snapshot.shells,
    setShells,
    activeShellId: snapshot.activeShellId,
    setActiveShellId,
  };
}

/**
 * Dock height in px — a SINGLE global value (not per-project), persisted to
 * localStorage so it survives project switches, window reloads, and app
 * restarts. Every open workspace shares one height; resizing in one is the
 * height everywhere.
 */
const HEIGHT_KEY = "plan.terminalHeight";
const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 120;

function readStoredHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT;
  const raw = window.localStorage.getItem(HEIGHT_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
}

let height = readStoredHeight();
const heightListeners = new Set<() => void>();

function subscribeHeight(listener: () => void) {
  heightListeners.add(listener);
  return () => {
    heightListeners.delete(listener);
  };
}

const setHeight: Dispatch<SetStateAction<number>> = (update) => {
  const next =
    typeof update === "function"
      ? (update as (p: number) => number)(height)
      : update;
  if (next === height) return;
  height = next;
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(next));
  } catch {
    // localStorage can throw (private mode / quota) — keep the in-memory value.
  }
  heightListeners.forEach((l) => l());
};

export function useTerminalHeight(): [
  number,
  Dispatch<SetStateAction<number>>,
] {
  const value = useSyncExternalStore(
    subscribeHeight,
    () => height,
    () => height
  );
  return [value, setHeight];
}
