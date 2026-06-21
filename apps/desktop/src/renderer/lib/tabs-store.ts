import { useCallback, useSyncExternalStore } from "react";

/**
 * Content-pane tabs, keyed by project `encoded`. Lives at module scope so it
 * survives `ProjectWorkspace` remounts (the workspace is keyed by `encoded`).
 * That keying is exactly what scopes tabs to a worktree: switching to a
 * different worktree reads that worktree's tabs (empty for a fresh one),
 * switching back restores the old ones. Persisted to localStorage so the set
 * also survives a full app quit & relaunch.
 *
 * A tab is identified by `id`, derived from WHAT it points at (file path / diff
 * target / session) so opening the same thing twice focuses the existing tab
 * instead of duplicating it. Titles and icons are NOT stored — they're derived
 * at render time from live data (session title, file basename) so a renamed
 * chat or moved file stays current.
 */
export type Tab =
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "diff"; subPath: string; path: string; staged: boolean }
  | { id: string; kind: "chat"; sessionId: string };

export type TabKind = Tab["kind"];

export function fileTabId(path: string): string {
  return `file:${path}`;
}
export function diffTabId(
  subPath: string,
  path: string,
  staged: boolean,
): string {
  return `diff:${subPath}::${path}::${staged ? "s" : "u"}`;
}
export function chatTabId(sessionId: string): string {
  return `chat:${sessionId}`;
}

export function makeFileTab(path: string): Tab {
  return { id: fileTabId(path), kind: "file", path };
}
export function makeDiffTab(
  subPath: string,
  path: string,
  staged: boolean,
): Tab {
  return { id: diffTabId(subPath, path, staged), kind: "diff", subPath, path, staged };
}
export function makeChatTab(sessionId: string): Tab {
  return { id: chatTabId(sessionId), kind: "chat", sessionId };
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

const EMPTY: TabsState = { tabs: [], activeId: null };

const store = new Map<string, TabsState>();
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

function storageKey(encoded: string): string {
  return `plan.tabs.${encoded}`;
}

/** Narrow an unknown parsed value into a Tab, dropping anything malformed. */
function reviveTab(raw: unknown): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.kind === "file" && typeof t.path === "string") {
    return makeFileTab(t.path);
  }
  if (
    t.kind === "diff" &&
    typeof t.subPath === "string" &&
    typeof t.path === "string" &&
    typeof t.staged === "boolean"
  ) {
    return makeDiffTab(t.subPath, t.path, t.staged);
  }
  if (t.kind === "chat" && typeof t.sessionId === "string") {
    return makeChatTab(t.sessionId);
  }
  return null;
}

function load(encoded: string): TabsState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(storageKey(encoded));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.map(reviveTab).filter((t): t is Tab => t !== null)
      : [];
    const activeId =
      typeof parsed.activeId === "string" &&
      tabs.some((t) => t.id === parsed.activeId)
        ? parsed.activeId
        : (tabs[tabs.length - 1]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return EMPTY;
  }
}

function get(encoded: string): TabsState {
  let state = store.get(encoded);
  if (!state) {
    state = load(encoded);
    store.set(encoded, state);
  }
  return state;
}

function persist(encoded: string, state: TabsState) {
  try {
    window.localStorage.setItem(storageKey(encoded), JSON.stringify(state));
  } catch {
    // localStorage can throw (private mode / quota) — keep the in-memory value.
  }
}

function set(encoded: string, next: TabsState) {
  store.set(encoded, next);
  persist(encoded, next);
  emit();
}

// ── Imperative API (works whether or not the workspace is mounted) ──────────
// Used for cross-worktree opens (the sessions dashboard opens a chat in a
// worktree that isn't mounted yet — the persisted state is read on mount) and
// for reconciling diff tabs against fresh git status outside React.

/** Current tabs for a worktree, loading from storage on first touch. */
export function getProjectTabs(encoded: string): TabsState {
  return get(encoded);
}

/** Focus an existing tab for this target, or append it and focus it. */
export function openProjectTab(encoded: string, tab: Tab) {
  const cur = get(encoded);
  const existing = cur.tabs.find((t) => t.id === tab.id);
  if (existing) {
    if (cur.activeId === tab.id) return;
    set(encoded, { ...cur, activeId: tab.id });
    return;
  }
  set(encoded, { tabs: [...cur.tabs, tab], activeId: tab.id });
}

/** Remove a tab; if it was active, fall back to its right/left neighbour. */
export function closeProjectTab(encoded: string, id: string) {
  const cur = get(encoded);
  const idx = cur.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tabs = cur.tabs.filter((t) => t.id !== id);
  let activeId = cur.activeId;
  if (activeId === id) {
    const next = cur.tabs[idx + 1] ?? cur.tabs[idx - 1] ?? null;
    activeId = next?.id ?? null;
  }
  set(encoded, { tabs, activeId });
}

/**
 * Swap a tab in place, keeping its position and active-state — used when a diff
 * tab's identity changes (staging flips it from the unstaged to the staged side
 * and vice-versa), so the open tab follows the file across sides.
 */
export function replaceProjectTab(encoded: string, oldId: string, next: Tab) {
  const cur = get(encoded);
  const idx = cur.tabs.findIndex((t) => t.id === oldId);
  if (idx === -1) return;
  const wasActive = cur.activeId === oldId;
  // If a tab for the new identity is already open, just drop the old one and
  // (if it was active) move focus onto the survivor instead of duplicating.
  if (next.id !== oldId && cur.tabs.some((t) => t.id === next.id)) {
    const tabs = cur.tabs.filter((t) => t.id !== oldId);
    set(encoded, { tabs, activeId: wasActive ? next.id : cur.activeId });
    return;
  }
  const tabs = cur.tabs.map((t) => (t.id === oldId ? next : t));
  set(encoded, { tabs, activeId: wasActive ? next.id : cur.activeId });
}

export function setActiveProjectTab(encoded: string, id: string) {
  const cur = get(encoded);
  if (cur.activeId === id) return;
  if (!cur.tabs.some((t) => t.id === id)) return;
  set(encoded, { ...cur, activeId: id });
}

export interface ProjectTabs extends TabsState {
  /** Focus an existing tab for this target, or append it and focus it. */
  openTab: (tab: Tab) => void;
  /** Remove a tab; if it was active, fall back to its neighbour. */
  closeTab: (id: string) => void;
  /** Close whatever tab is currently active. */
  closeActive: () => void;
  setActive: (id: string) => void;
}

export function useProjectTabs(encoded: string): ProjectTabs {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded),
  );

  const openTab = useCallback(
    (tab: Tab) => openProjectTab(encoded, tab),
    [encoded],
  );

  const closeTab = useCallback(
    (id: string) => closeProjectTab(encoded, id),
    [encoded],
  );

  const closeActive = useCallback(() => {
    const cur = get(encoded);
    if (cur.activeId) closeProjectTab(encoded, cur.activeId);
  }, [encoded]);

  const setActive = useCallback(
    (id: string) => setActiveProjectTab(encoded, id),
    [encoded],
  );

  return {
    tabs: snapshot.tabs,
    activeId: snapshot.activeId,
    openTab,
    closeTab,
    closeActive,
    setActive,
  };
}
