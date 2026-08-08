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
  /** Command a shell was spawned to run, by shell id. Read once, when its pane
   *  creates the pty. Shell numbering reuses gaps after a close, so an entry
   *  MUST die with its shell — otherwise the next shell to take that id would
   *  re-run a command the user never asked for again. */
  shellCommands: Record<string, string>;
  /** Bumped when a shell is spawned from outside the sidebar (a chat code
   *  block's run button), which has no other way to reveal the pane. */
  revealTick: number;
}

const DEFAULT: TerminalState = {
  openedIds: [],
  open: false,
  shells: [],
  activeShellId: null,
  shellCommands: {},
  revealTick: 0,
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
  key: K,
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

/**
 * Add a scratch shell and select it — in ONE update, because a pane reads its
 * `initialCommand` when it mounts and creates the pty. Landing the shell and
 * its command in separate updates would let the pane mount against a state
 * where the command isn't there yet, and the shell would come up empty.
 */
export function spawnShell(encoded: string, id: string, command?: string) {
  const cur = get(encoded);
  store.set(encoded, {
    ...cur,
    shells: cur.shells.includes(id) ? cur.shells : [...cur.shells, id],
    activeShellId: id,
    shellCommands: command
      ? { ...cur.shellCommands, [id]: command }
      : cur.shellCommands,
    revealTick: command ? cur.revealTick + 1 : cur.revealTick,
  });
  emit();
}

/** Drop a shell from the sidebar (its pty is the caller's business), forgetting
 *  the command it was spawned with and falling back to the newest remaining
 *  shell if the one shown is the one leaving. */
export function forgetShell(encoded: string, id: string) {
  const cur = get(encoded);
  if (!cur.shells.includes(id)) return;
  const remaining = cur.shells.filter((x) => x !== id);
  const { [id]: _dropped, ...shellCommands } = cur.shellCommands;
  store.set(encoded, {
    ...cur,
    shells: remaining,
    shellCommands,
    activeShellId:
      cur.activeShellId === id
        ? (remaining[remaining.length - 1] ?? null)
        : cur.activeShellId,
  });
  emit();
}

export function useProjectTerminals(encoded: string): {
  openedIds: string[];
  setOpenedIds: Dispatch<SetStateAction<string[]>>;
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  shells: string[];
  activeShellId: string | null;
  setActiveShellId: Dispatch<SetStateAction<string | null>>;
  shellCommands: Record<string, string>;
  revealTick: number;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded),
  );

  const setOpenedIds = useCallback(makeSetter(encoded, "openedIds"), [encoded]);
  const setTerminalOpen = useCallback(makeSetter(encoded, "open"), [encoded]);
  const setActiveShellId = useCallback(makeSetter(encoded, "activeShellId"), [
    encoded,
  ]);

  return {
    openedIds: snapshot.openedIds,
    setOpenedIds,
    terminalOpen: snapshot.open,
    setTerminalOpen,
    shells: snapshot.shells,
    activeShellId: snapshot.activeShellId,
    setActiveShellId,
    shellCommands: snapshot.shellCommands,
    revealTick: snapshot.revealTick,
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
    () => height,
  );
  return [value, setHeight];
}
