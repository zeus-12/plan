import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useProjectTabs, makeChatTab, type Tab } from "./tabs-store";
import {
  getMruScopeVersion,
  orderByMru,
  recordUse,
  subscribeMru,
} from "./mru-store";

/** Which LIST the middle sidebar shows (VS Code activity-bar model). */
export type WorkTab = "diffs" | "chat" | "files" | "search" | "pr";

/** One Ctrl+Tab switcher row: an open tab, or a chat session without one. */
export type SwitcherEntry =
  | { type: "tab"; id: string; tab: Tab }
  | { type: "session"; id: string; sessionId: string; title: string };

/**
 * The workspace's tab routing — one module owns the relationship between the
 * sidebar's list choice (`tab`), the content pane's open tabs (tabs-store),
 * and everything derived from the active tab: which pane kind is showing
 * (`openKind`) and the per-kind selections the sidebar lists highlight.
 *
 * The open-tab list is the single source of truth for the CONTENT pane;
 * `tab` only picks the sidebar list. They usually move together (reveal flows
 * set both) but may deliberately diverge — e.g. browsing the Files list while
 * a chat tab stays active — which is why both live here, behind one seam,
 * instead of being re-derived ad hoc at call sites.
 *
 * Also owns the Ctrl+Tab ordering: per-worktree MRU over open tabs (Alt-Tab
 * semantics), followed by chat sessions without an open tab so the switcher
 * can reach any chat.
 */
export function useWorkspaceTabs(
  encoded: string,
  /** The project's chat sessions (only these fields matter to the switcher). */
  sessions: readonly {
    sessionId: string;
    title: string | null;
    archived: boolean;
  }[],
  showChats: boolean,
) {
  const [tab, setTab] = useState<WorkTab>(() => (showChats ? "chat" : "diffs"));
  const {
    tabs: storedTabs,
    activeId: storedActiveId,
    openTab,
    closeTab,
    setActive,
  } = useProjectTabs(encoded);

  useEffect(() => {
    if (!showChats && tab === "chat") setTab("diffs");
  }, [showChats, tab]);

  const tabs = useMemo(
    () =>
      showChats ? storedTabs : storedTabs.filter((t) => t.kind !== "chat"),
    [showChats, storedTabs],
  );
  const activeId = tabs.some((t) => t.id === storedActiveId)
    ? storedActiveId
    : (tabs[tabs.length - 1]?.id ?? null);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );

  /** The pane kind the content area is showing (derived from the active tab). */
  const openKind: WorkTab | null =
    activeTab?.kind === "chat"
      ? "chat"
      : activeTab?.kind === "diff"
        ? "diffs"
        : activeTab?.kind === "file"
          ? "files"
          : activeTab?.kind === "pr"
            ? "pr"
            : null;

  // Per-kind selections, derived from the active tab. Stable references where
  // consumers are memoized on them.
  const selectedSessionId =
    activeTab?.kind === "chat" ? activeTab.sessionId : null;
  const selectedFile = useMemo(
    () =>
      activeTab?.kind === "diff"
        ? {
            subPath: activeTab.subPath,
            path: activeTab.path,
            staged: activeTab.staged,
          }
        : null,
    [activeTab],
  );
  const selectedProjectFile =
    activeTab?.kind === "file" ? activeTab.path : null;
  // Stable reference so MiddleSidebar's memo isn't broken every keystroke.
  const activePr = useMemo(
    () =>
      activeTab?.kind === "pr"
        ? { subPath: activeTab.subPath, number: activeTab.number }
        : null,
    [activeTab],
  );
  // The file currently of interest — the open diff or file. Shared across the
  // Diffs and Files sidebar lists so each highlights it. Project-relative
  // (repo subPath prefixed) to compare across both lists.
  const activeFilePath =
    activeTab?.kind === "file"
      ? activeTab.path
      : activeTab?.kind === "diff"
        ? activeTab.subPath
          ? `${activeTab.subPath}/${activeTab.path}`
          : activeTab.path
        : null;

  const openChatTab = useCallback(
    (sid: string) => openTab(makeChatTab(sid)),
    [openTab],
  );

  const closeActive = useCallback(() => {
    if (activeId) closeTab(activeId);
  }, [activeId, closeTab]);

  // ── Ctrl+Tab ordering (per-worktree MRU + sessions without a tab) ──
  const tabsMruScope = `tabs:${encoded}`;
  // Subscribe to THIS worktree's tab scope only — a project switch elsewhere
  // bumps the "projects" scope and must not re-render the whole workspace's
  // tab ordering.
  const getTabsMruVersion = useCallback(
    () => getMruScopeVersion(tabsMruScope),
    [tabsMruScope],
  );
  const mruVersion = useSyncExternalStore(
    subscribeMru,
    getTabsMruVersion,
    getTabsMruVersion,
  );
  const tabsByMru = useMemo(
    () => orderByMru(tabsMruScope, tabs, (t) => t.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mruVersion IS the store's change signal
    [tabsMruScope, tabs, mruVersion],
  );
  useEffect(() => {
    if (activeId) recordUse(tabsMruScope, activeId);
  }, [tabsMruScope, activeId]);

  // The switcher lists open tabs first, then chat sessions WITHOUT an open tab
  // (newest-first — `sessions` is already sorted that way), so Ctrl+Tab can
  // reach any chat without going through the ⌘A palette. Committing a tab
  // activates it; committing a session opens it as a chat tab.
  const switcherEntries = useMemo<SwitcherEntry[]>(() => {
    const openSessionIds = new Set(
      tabs.filter((t) => t.kind === "chat").map((t) => t.sessionId),
    );
    const tabEntries: SwitcherEntry[] = tabsByMru.map((t) => ({
      type: "tab",
      id: t.id,
      tab: t,
    }));
    const sessionEntries: SwitcherEntry[] = showChats
      ? sessions
          .filter((s) => !s.archived && !openSessionIds.has(s.sessionId))
          .map((s) => ({
            type: "session" as const,
            id: `switch-session:${s.sessionId}`,
            sessionId: s.sessionId,
            title: s.title ?? "Chat",
          }))
      : [];
    return [...tabEntries, ...sessionEntries];
  }, [tabsByMru, tabs, sessions, showChats]);

  // Index of the active tab, or -1 when nothing is open so the first tap lands
  // on the first entry rather than skipping it.
  const switcherCurrentIndex = activeId
    ? switcherEntries.findIndex((e) => e.type === "tab" && e.id === activeId)
    : -1;
  // The first session entry carries the divider — but only when tabs precede
  // it, so a tabs-only or sessions-only list shows no stray line.
  const firstSessionSwitcherId = switcherEntries.find(
    (e) => e.type === "session",
  )?.id;
  const hasOpenTabs = tabsByMru.length > 0;

  // The chat a worktree-level action (one taken from a diff/file/PR tab, where
  // there is no selected session) should land on: the most recently used open
  // chat tab, which IS the active tab whenever that tab is a chat. Null when
  // the worktree has no chat tab open at all.
  const mruChatSessionId = showChats
    ? (tabsByMru.find((t) => t.kind === "chat")?.sessionId ?? null)
    : null;

  return {
    /** Which sidebar list shows. */
    tab,
    setTab,
    // Open-tab state (tabs-store passthrough).
    tabs,
    activeId,
    activeTab,
    openTab,
    closeTab,
    closeActive,
    setActive,
    openChatTab,
    // Derived from the active tab.
    openKind,
    selectedSessionId,
    mruChatSessionId,
    selectedFile,
    selectedProjectFile,
    activePr,
    activeFilePath,
    // Ctrl+Tab switcher data.
    switcherEntries,
    switcherCurrentIndex,
    firstSessionSwitcherId,
    hasOpenTabs,
  };
}
