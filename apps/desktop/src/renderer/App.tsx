import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SidebarProvider,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { TooltipProvider } from "@plan/shared/components/ui/tooltip";
import { lastSegment } from "@plan/shared/lib/path";
import { sameJson } from "@plan/shared/lib/utils";
import type { DiscoveredRepo, ProjectEntry } from "../shared-types";
import { ProjectSidebar } from "./components/project-sidebar";
import { WorkspaceHost, type MountTarget } from "./components/workspace-host";
import { Toaster } from "@plan/shared/components/ui/sonner";
import { SwitcherOverlay } from "./components/switcher-overlay";
import type { ClaudeConfigScope, WorktreeRecord } from "../shared-types";
import { UpdateBanner } from "./components/update-banner";

// Modals are only mounted when opened, so lazy-load them — keeps their code
// (and deps) out of the initial bundle and off the cold-start critical path.
const SessionsDashboard = lazy(() =>
  import("./components/sessions-dashboard").then((m) => ({
    default: m.SessionsDashboard,
  })),
);
const SettingsModal = lazy(() =>
  import("./components/settings-modal").then((m) => ({
    default: m.SettingsModal,
  })),
);
const KeyboardShortcutsModal = lazy(() =>
  import("./components/keyboard-shortcuts-modal").then((m) => ({
    default: m.KeyboardShortcutsModal,
  })),
);
const ClaudeConfigModal = lazy(() =>
  import("./components/claude-config-modal").then((m) => ({
    default: m.ClaudeConfigModal,
  })),
);
const NewWorktreeModal = lazy(() =>
  import("./components/new-worktree-modal").then((m) => ({
    default: m.NewWorktreeModal,
  })),
);
const AddReposModal = lazy(() =>
  import("./components/add-repos-modal").then((m) => ({
    default: m.AddReposModal,
  })),
);
const CreatePrModal = lazy(() =>
  import("./components/create-pr-modal").then((m) => ({
    default: m.CreatePrModal,
  })),
);
const ProjectDefaultsModal = lazy(() =>
  import("./components/project-defaults-modal").then((m) => ({
    default: m.ProjectDefaultsModal,
  })),
);
const MoveSessionModal = lazy(() =>
  import("./components/move-session-modal").then((m) => ({
    default: m.MoveSessionModal,
  })),
);
import { useConfirm } from "./components/confirm-dialog";
import { useWorktrees } from "./lib/use-worktrees";
import { useAllWorktrees } from "./lib/use-all-worktrees";
import { useTabSwitcher } from "./lib/use-tab-switcher";
import {
  openProjectTab,
  closeProjectTab,
  makeChatTab,
  chatTabId,
} from "./lib/tabs-store";
import { handleReloadRequest } from "./lib/reload-override";
import { forgetNewSession } from "./lib/new-session-ids";
import { removeCachedSession } from "./lib/session-cache";
import { AttentionSwitcher } from "./attention-switcher";
import type { AttentionTarget } from "./attention-switcher";
import { pushToast } from "./lib/toast-store";
import {
  getMruScopeVersion,
  orderByMru,
  recordUse,
  subscribeMru,
} from "./lib/mru-store";
import {
  toggleBionicReading,
  useApplyTranscriptPrefs,
} from "./lib/transcript-prefs";
import { startSessionDoneNotifier } from "./lib/session-done-notifier";
import { startSessionApprovalNotifier } from "./lib/session-approval-notifier";
import { startAutoContinueWatcher } from "./lib/auto-continue-watcher";
import {
  setSessionLabelResolver,
  setSessionNavigator,
} from "./lib/session-notify";

const SELECTED_PROJECT_KEY = "plan.selectedProject";
// The focused worktree persists alongside it so a relaunch lands back on the
// worktree, not its parent project's working copy.
const SELECTED_WORKTREE_KEY = "plan.selectedWorktree";

// How many recently-visited workspaces stay mounted at once. Switching to one
// already in the pool is instant (just un-hidden); older ones are unmounted
// (LRU) so their terminals/watchers don't accumulate. 3 covers the common
// alt-tab-between-a-few pattern without holding many heavy ptys/xterms live.
const MAX_MOUNTED_WORKSPACES = 3;

// The switcher's MRU scope: one flat recency list spanning every navigable
// destination — each project's working copy AND every worktree. A destination's
// id is `p:<encoded>` (working copy) or `w:<worktreeId>` (worktree).
const SWITCH_MRU_SCOPE = "switch";
const switchTargetId = (encoded: string, worktreeId: string | null) =>
  worktreeId ? `w:${worktreeId}` : `p:${encoded}`;
// Stable getSnapshot for useSyncExternalStore — reads only the switcher scope.
const getSwitchMruVersion = () => getMruScopeVersion(SWITCH_MRU_SCOPE);

function Shell() {
  const projectsSidebar = useSidebar();
  // Apply the reader's transcript font/size/brightness prefs before first paint.
  useApplyTranscriptPrefs();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  // Selected project persists across restarts so focus stays put.
  const [selectedEncoded, setSelectedEncoded] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(SELECTED_PROJECT_KEY),
  );
  const [reposByProject, setReposByProject] = useState<
    Map<string, DiscoveredRepo[]>
  >(new Map());
  const [iconsByProject, setIconsByProject] = useState<Map<string, string>>(
    new Map(),
  );

  // Project icons (repo favicon / GitHub avatar, resolved by the main process).
  // Keyed off the SET of projects, not the list identity — the list is re-pulled
  // on every watcher tick and we don't want to re-resolve icons each time.
  const iconsKey = useMemo(
    () =>
      projects
        .map((p) => p.encoded)
        .sort()
        .join("\n"),
    [projects],
  );
  useEffect(() => {
    if (!iconsKey) return;
    let cancelled = false;
    void window.electronAPI.getProjectIcons(iconsKey.split("\n")).then(
      (icons) => {
        if (!cancelled) setIconsByProject(new Map(Object.entries(icons)));
      },
      () => {
        // Resolution failed outright — keep whatever we last knew.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [iconsKey]);

  /**
   * Discover repos for every project in parallel. The result drives:
   *   - sidebar branch labels (we pick the first repo's branch),
   *   - sidebar grouping (worktrees share a git common dir), and
   *   - the multi-repo file view inside the workspace.
   */
  const refreshRepos = useCallback(
    async (targets: ProjectEntry[], allEncodeds?: string[]) => {
      const entries = await Promise.all(
        targets.map(async (p) => {
          try {
            const repos = await window.electronAPI.listRepos(p.encoded);
            return [p.encoded, repos] as const;
          } catch {
            return [p.encoded, [] as DiscoveredRepo[]] as const;
          }
        }),
      );
      // Merge + dedupe: unchanged answers keep the previous Map identity so
      // the memoized workspaces don't re-render on every watcher tick.
      setReposByProject((prev) => {
        let changed = false;
        const next = new Map(prev);
        if (allEncodeds) {
          const keep = new Set(allEncodeds);
          for (const k of next.keys()) {
            if (!keep.has(k)) {
              next.delete(k);
              changed = true;
            }
          }
        }
        for (const [encoded, repos] of entries) {
          if (!sameJson(next.get(encoded) ?? null, repos)) {
            next.set(encoded, repos);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  // The project SET last seen — repo discovery re-runs for every project only
  // when this changes (same idea as iconsKey); per-tick refreshes are scoped to
  // the projects that actually emitted events.
  const knownProjectsKeyRef = useRef<string | null>(null);

  const refreshProjects = useCallback(
    async (changed?: ReadonlySet<string>) => {
      const list = await window.electronAPI.listProjects();
      // Watcher ticks usually return identical content — keep the identity so
      // every `projects`-prop memo downstream keeps working while streaming.
      setProjects((prev) => (sameJson(prev, list) ? prev : list));
      setSelectedEncoded((current) => {
        // Keep the current selection; only fall back when it's gone (or unset).
        if (current && list.some((p) => p.encoded === current)) return current;
        const stored = window.localStorage.getItem(SELECTED_PROJECT_KEY);
        if (stored && list.some((p) => p.encoded === stored)) return stored;
        return (
          list.find((p) => !p.archived)?.encoded ?? list[0]?.encoded ?? null
        );
      });
      const key = list
        .map((p) => p.encoded)
        .sort()
        .join("\n");
      const setChanged = key !== knownProjectsKeyRef.current;
      knownProjectsKeyRef.current = key;
      if (setChanged || !changed) {
        // First load or the project set itself changed: (re)discover them all
        // and prune removed ones.
        void refreshRepos(
          list,
          list.map((p) => p.encoded),
        );
      } else if (changed.size > 0) {
        // Routine tick: re-inspect only the projects with activity (their
        // branch may have moved) instead of spawning git for every project.
        void refreshRepos(list.filter((p) => changed.has(p.encoded)));
      }
    },
    [refreshRepos],
  );

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  // Persist the selected project.
  useEffect(() => {
    if (selectedEncoded)
      window.localStorage.setItem(SELECTED_PROJECT_KEY, selectedEncoded);
  }, [selectedEncoded]);

  useEffect(() => {
    // Re-pull the project/repo list on activity (debounced — events stream
    // continuously while a session runs), but never change which project is
    // focused — switching out from under the user is jarring. The events seen
    // during the window scope the repo re-discovery to the projects involved.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let changed = new Set<string>();
    const off = window.electronAPI.onWatcherEvent((e) => {
      changed.add(e.encoded);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const batch = changed;
        changed = new Set();
        void refreshProjects(batch);
      }, 500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refreshProjects]);

  // ⌘R: main forwards the press here (it no longer reloads directly). An open
  // data page — the PR view — claims it to force-refresh its own data; with no
  // claimant this falls back to the ordinary full-app reload.
  useEffect(() => window.electronAPI.onReloadRequest(handleReloadRequest), []);

  const handleAddProject = useCallback(async () => {
    const added = await window.electronAPI.addManualProject();
    if (added) {
      await refreshProjects();
      setSelectedEncoded(added.encoded);
      setActiveWorktreeId(null);
    }
  }, [refreshProjects]);

  const handleSetArchived = useCallback(
    async (encoded: string, archived: boolean) => {
      await window.electronAPI.setProjectArchived(encoded, archived);
      // Reflect in local state immediately so the row moves between sections.
      setProjects((prev) =>
        prev.map((p) => (p.encoded === encoded ? { ...p, archived } : p)),
      );
      // If we just archived the selected project, jump to the first active one.
      if (archived && selectedEncoded === encoded) {
        const fallback = projects.find(
          (p) => p.encoded !== encoded && !p.archived,
        );
        setSelectedEncoded(fallback ? fallback.encoded : null);
        setActiveWorktreeId(null);
      }
    },
    [projects, selectedEncoded],
  );

  const selected = projects.find((p) => p.encoded === selectedEncoded) ?? null;

  // ── Worktrees ───────────────────────────────────────────────────────
  const { confirm, dialog: confirmDialog } = useConfirm();
  // The selected project's worktrees + defaults drive the modals and Run/Build
  // command lists; the merged sidebar nests worktrees for EVERY project, so it
  // reads the all-projects map instead.
  const worktrees = useWorktrees(selectedEncoded ?? "");
  const allWorktrees = useAllWorktrees();
  // null = the live working copy (the real checkout). Seeded from the last
  // session; a stale id (worktree removed since) is cleared once the worktree
  // list loads, below.
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(SELECTED_WORKTREE_KEY),
  );
  // Persist the focused worktree (cleared when focus is the working copy).
  useEffect(() => {
    if (activeWorktreeId)
      window.localStorage.setItem(SELECTED_WORKTREE_KEY, activeWorktreeId);
    else window.localStorage.removeItem(SELECTED_WORKTREE_KEY);
  }, [activeWorktreeId]);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  // Worktree id whose Create-PR modal is open (null = closed).
  const [prWorktreeId, setPrWorktreeId] = useState<string | null>(null);
  // Worktree id whose Add-repos modal is open (null = closed).
  const [addReposWorktreeId, setAddReposWorktreeId] = useState<string | null>(
    null,
  );

  // Flat id → record across all projects, so sidebar actions (PR / remove /
  // add-repos) and their modals resolve a worktree even when its project isn't
  // the selected one.
  const worktreeById = useMemo(() => {
    const m = new Map<string, WorktreeRecord>();
    for (const list of allWorktrees.byProject.values())
      for (const w of list) m.set(w.id, w);
    return m;
  }, [allWorktrees.byProject]);

  // Selection updates are URGENT — the click must visibly land (sidebar
  // highlight, header) on the very next frame. The expensive part of a switch
  // (mounting the target workspace) is deferred separately via
  // `useDeferredValue(activeTarget)` below, so it trails the click without
  // ever swallowing it. (These used to wrap the whole switch in
  // startTransition, which let streaming-tick state updates interrupt and
  // restart the multi-second cold-mount render — clicks appeared to simply
  // not register until the transition finally got through.)
  // Local = within the selected project (live-copy toggle, ⌘1 switcher).
  const selectWorktreeLocal = useCallback((id: string | null) => {
    setActiveWorktreeId(id);
  }, []);
  // Cross-project = clicking a worktree under any project in the sidebar. Sets
  // both project + worktree atomically so neither clobbers the other.
  const selectWorktree = useCallback((projectEncoded: string, id: string) => {
    setSelectedEncoded(projectEncoded);
    setActiveWorktreeId(id);
  }, []);

  const handleNewWorktree = useCallback((projectEncoded: string) => {
    // Select the target project synchronously (not via the transition-wrapped
    // selectProject) so the modal reads that project's encoded + defaults.
    setSelectedEncoded(projectEncoded);
    setActiveWorktreeId(null);
    setShowNewWorktree(true);
  }, []);

  const handleOpenProjectDefaults = useCallback((projectEncoded: string) => {
    setSelectedEncoded(projectEncoded);
    setActiveWorktreeId(null);
    setShowDefaults(true);
  }, []);

  // ── Move a chat session to another worktree ─────────────────────────
  // The session being moved always lives at the currently-mounted encoded
  // (effectiveProject.encoded); its project is `selectedEncoded`.
  const [moveSession, setMoveSession] = useState<{
    sessionId: string;
    title: string;
    fromEncoded: string;
  } | null>(null);
  // When true, the New-worktree modal is open to receive a moved session: on
  // create we relocate the chat into it instead of just selecting it.
  const [pendingMoveOnCreate, setPendingMoveOnCreate] = useState(false);

  // Resolved from the all-projects map (not the selected project's list, which
  // refetches on every project switch) so a restored id resolves as soon as
  // the one startup fetch lands. The project match keeps a stale id from ever
  // pairing another project's worktree with the selected project.
  const activeWorktreeCandidate = activeWorktreeId
    ? (worktreeById.get(activeWorktreeId) ?? null)
    : null;
  const activeWorktree =
    activeWorktreeCandidate?.projectEncoded === selectedEncoded
      ? activeWorktreeCandidate
      : null;

  // A restored worktree id can be stale — removed while the app was closed.
  // Once the all-worktrees list has loaded, an unresolvable id falls back to
  // the working copy. (Every in-app flow that sets an id refreshes that list
  // first, so a live selection never trips this.)
  useEffect(() => {
    if (allWorktrees.loaded && activeWorktreeId && !activeWorktree)
      setActiveWorktreeId(null);
  }, [allWorktrees.loaded, activeWorktreeId, activeWorktree]);
  const prWorktree = prWorktreeId
    ? (worktreeById.get(prWorktreeId) ?? null)
    : null;
  const addReposWorktree = addReposWorktreeId
    ? (worktreeById.get(addReposWorktreeId) ?? null)
    : null;

  // The project (or synthesized worktree "project") currently in focus. Still
  // computed here because the move-session flow reads it; the workspace pool
  // below resolves each mounted target's own project inside WorkspaceHost.
  const effectiveProject: ProjectEntry | null = activeWorktree
    ? {
        encoded: activeWorktree.encoded,
        cwd: activeWorktree.rootPath,
        mtimeMs: activeWorktree.createdAt,
        archived: false,
      }
    : selected;

  // ── Keep-alive workspace pool ────────────────────────────────────────
  // Switching project/worktree used to remount the whole ProjectWorkspace
  // (it's keyed by encoded) — a full teardown + rebuild every time. Instead we
  // keep the N most-recently-visited workspaces MOUNTED and just toggle which
  // one is visible, so switching back is instant. `activeTarget` is the one on
  // screen; `mountTargets` is the LRU set that's alive.
  // Built from primitives (NOT `effectiveProject`, which is a fresh object each
  // render) so its identity only changes on an actual switch — otherwise the
  // reconcile effect below would loop.
  const activeTarget = useMemo<MountTarget | null>(() => {
    if (!selectedEncoded) return null;
    // A worktree id that hasn't resolved yet (restored at launch, list still
    // loading): mount nothing rather than flash-mounting the working copy and
    // then switching. It resolves — or is cleared as stale — one fetch later.
    if (activeWorktreeId && !activeWorktree) return null;
    return {
      encoded: activeWorktree ? activeWorktree.encoded : selectedEncoded,
      projectEncoded: selectedEncoded,
      worktreeId: activeWorktree ? activeWorktree.id : null,
    };
  }, [selectedEncoded, activeWorktreeId, activeWorktree]);

  // The pool renders against a DEFERRED copy of the target: the click's urgent
  // render (sidebar highlight, header) commits on the next frame with the OLD
  // workspace still on screen and interactive, and React mounts the new one in
  // a low-priority render that follows. Deferring here — rather than wrapping
  // the selection setters in startTransition — is what keeps the click itself
  // instant no matter how heavy the target workspace is.
  const deferredTarget = useDeferredValue(activeTarget);

  const [mountTargets, setMountTargets] = useState<MountTarget[]>([]);
  useEffect(() => {
    if (!deferredTarget) return;
    setMountTargets((prev) => {
      // Already focused → nothing to reorder. Returning `prev` (not a fresh
      // array) is what stops this effect from re-rendering every tick.
      if (prev[0]?.encoded === deferredTarget.encoded) return prev;
      // Reuse the existing object for this encoded so its identity stays stable
      // across switches — that's what lets the memoized background hosts skip
      // re-rendering when you switch away from and back to them.
      const existing = prev.find((t) => t.encoded === deferredTarget.encoded);
      const head = existing ?? deferredTarget;
      const rest = prev.filter((t) => t.encoded !== deferredTarget.encoded);
      return [head, ...rest].slice(0, MAX_MOUNTED_WORKSPACES);
    });
  }, [deferredTarget]);

  // What to actually render: the LRU set, plus the deferred target if the
  // effect hasn't folded it in yet (first visit) — so switching to a brand-new
  // target paints it in the deferred pass instead of a blank frame while all
  // hosts are hidden.
  const renderTargets = useMemo<MountTarget[]>(() => {
    if (!deferredTarget) return mountTargets;
    if (mountTargets.some((t) => t.encoded === deferredTarget.encoded))
      return mountTargets;
    return [deferredTarget, ...mountTargets].slice(0, MAX_MOUNTED_WORKSPACES);
  }, [mountTargets, deferredTarget]);

  const handleRemoveWorktree = useCallback(
    async (id: string) => {
      const wt = worktreeById.get(id);
      const ok = await confirm({
        title: `Remove worktree "${wt?.name ?? ""}"?`,
        description:
          "Deletes the checkout and any uncommitted work. Chats move to the project's archive; the branch stays.",
        confirmLabel: "Remove worktree",
      });
      if (!ok) return;
      if (activeWorktreeId === id) setActiveWorktreeId(null);
      await worktrees.remove(id);
      await allWorktrees.refresh();
    },
    [worktrees, worktreeById, allWorktrees, confirm, activeWorktreeId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // ⌘, → Settings (the standard macOS Preferences shortcut). Fires
      // regardless of focus so it's reachable while typing.
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // ⌘/ → the keyboard-shortcuts reference, reachable from anywhere.
      if (e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘⇧B → toggle bionic reading. Global so it's reachable while reading
  // anywhere; kept separate because the ⌘,/⌘/ handler above bails on Shift.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "b"
      ) {
        e.preventDefault();
        toggleBionicReading();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sessions dashboard: a control-center for every live Claude pty.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Claude instructions/memory viewer; the scope decides which section it opens
  // on. Global comes from the left sidebar, project/memory from the right.
  const [claudeConfigScope, setClaudeConfigScope] =
    useState<ClaudeConfigScope | null>(null);

  // Watch every live Claude session for completion and notify globally. Started
  // once here at the app root so it covers background sessions too, not just the
  // one on screen.
  useEffect(() => startSessionDoneNotifier(), []);
  // And watch every live session for an approval/selection menu, so a session
  // that parks on a prompt raises a notification even when it's in a project or
  // worktree that isn't on screen. Sidebar badges read the same store.
  useEffect(() => startSessionApprovalNotifier(), []);
  // And watch every live session for a turn that died on a transient API error,
  // so one that drops mid-response gets nudged back instead of parking until
  // it's noticed. Gated on the auto-continue setting, checked when it fires.
  useEffect(() => startAutoContinueWatcher(), []);
  // Keep the notification body's project label in sync with the project list.
  // Deliberately just the project name — no chat title, no session id.
  useEffect(() => {
    const byEncoded = new Map(
      projects.map((p) => [p.encoded, lastSegment(p.cwd)]),
    );
    setSessionLabelResolver((id) => {
      const m = id.match(/^chat:(.+):([^:]+)$/);
      return (m && byEncoded.get(m[1])) || "Claude";
    });
  }, [projects]);
  const navigateToSession = useCallback(
    (encoded: string, sessionId: string) => {
      // Open (or focus) the chat as a tab in the target worktree. This persists
      // to the tabs store, so it works whether that worktree is already mounted
      // (the store emit re-renders it) or not (it's read on mount).
      openProjectTab(encoded, makeChatTab(sessionId));
      selectProject(encoded);
      setDashboardOpen(false);
    },
    [],
  );

  // Let a "Claude is done" toast's "View" action jump to that session.
  useEffect(() => {
    setSessionNavigator((id) => {
      const m = id.match(/^chat:(.+):([^:]+)$/);
      if (m) navigateToSession(m[1], m[2]);
    });
  }, [navigateToSession]);

  // Archived projects are excluded from the switcher — you can't switch to one
  // you've hidden. mtime desc is only the fallback order, before anything has
  // been used this session; MRU (below) takes over as you navigate.
  const activeProjects = useMemo(
    () =>
      projects.filter((p) => !p.archived).sort((a, b) => b.mtimeMs - a.mtimeMs),
    [projects],
  );
  // Subscribe to the switcher scope only — a content-tab or chat switch in the
  // workspace bumps a different scope and must not re-render App/sidebar.
  const switchMruVersion = useSyncExternalStore(
    subscribeMru,
    getSwitchMruVersion,
    getSwitchMruVersion,
  );
  // Record the destination you land on — working copy OR worktree — so both
  // float up the switcher by recency, Alt-Tab style.
  useEffect(() => {
    if (selectedEncoded)
      recordUse(
        SWITCH_MRU_SCOPE,
        switchTargetId(selectedEncoded, activeWorktreeId),
      );
  }, [selectedEncoded, activeWorktreeId]);

  // Urgent for the same reason as selectWorktree above; the heavy remount
  // trails via the deferred mount target.
  const selectProject = useCallback((encoded: string | null) => {
    setSelectedEncoded(encoded);
    // Selecting a project lands on its live working copy.
    setActiveWorktreeId(null);
  }, []);

  // Kept identity-stable (reads the focused project via a ref) so it isn't a
  // fresh callback on every switch — otherwise it would re-render every mounted
  // workspace in the pool. Only the visible workspace can trigger a move, and it
  // is always `effectiveProject`, so the ref is correct at call time.
  const effectiveProjectRef = useRef(effectiveProject);
  effectiveProjectRef.current = effectiveProject;
  const handleRequestMoveSession = useCallback(
    (sessionId: string, title: string) => {
      const ep = effectiveProjectRef.current;
      if (!ep) return;
      setMoveSession({ sessionId, title, fromEncoded: ep.encoded });
    },
    [],
  );

  // Where a session can move: the project's other worktrees + its live copy,
  // minus wherever the session currently lives.
  const moveTargets = useMemo(() => {
    if (!moveSession || !selected) return [];
    const from = moveSession.fromEncoded;
    const out: {
      key: string;
      label: string;
      sub?: string;
      encoded: string;
      worktreeId: string | null;
    }[] = [];
    if (selected.encoded !== from) {
      out.push({
        key: "__live__",
        label: lastSegment(selected.cwd),
        sub: "working copy",
        encoded: selected.encoded,
        worktreeId: null,
      });
    }
    for (const w of worktrees.worktrees) {
      if (w.encoded === from) continue;
      out.push({
        key: w.id,
        label: w.name,
        sub: w.repos[0]?.branch ?? undefined,
        encoded: w.encoded,
        worktreeId: w.id,
      });
    }
    return out;
  }, [moveSession, selected, worktrees.worktrees]);

  // Relocate the chat: kill the old pty, move the transcript on disk, re-home
  // its tab, and follow it. `forgetNewSession` ensures it resumes (not
  // re-creates) in the new cwd. Verified: new turns anchor to the new worktree.
  const performMove = useCallback(
    async (toEncoded: string, toWorktreeId: string | null) => {
      const pending = moveSession;
      if (!pending || !selectedEncoded) return;
      const { sessionId, fromEncoded, title } = pending;
      // Main kills the source chat's pty and WAITS for it to exit before moving
      // the transcript (see session:move), so no live `claude` re-creates a stub
      // at the old path. Don't pre-kill here — that's the race we're fixing.
      await window.electronAPI.moveSession(sessionId, fromEncoded, toEncoded);
      forgetNewSession(sessionId);
      // Drop it from the source's cached list so it doesn't linger there.
      removeCachedSession(fromEncoded, sessionId);
      closeProjectTab(fromEncoded, chatTabId(sessionId));
      openProjectTab(toEncoded, makeChatTab(sessionId));
      if (toWorktreeId) selectWorktree(selectedEncoded, toWorktreeId);
      else selectProject(selectedEncoded);
      setMoveSession(null);
      pushToast({
        title: `Moved "${title}"`,
        description:
          "The chat now lives in the target worktree. Code it wrote stays on the original branch.",
      });
    },
    [moveSession, selectedEncoded, selectWorktree, selectProject],
  );

  // Ctrl+` cycles EVERYTHING you can navigate to: every project's working copy
  // plus every worktree, in ONE flat most-recently-used list. Any destination
  // you visit floats to the top, so a single tap-release returns you to where
  // you just were (Alt-Tab), whether that's a project or a worktree. The branch
  // glyph + parent-project subtitle keep worktrees identifiable once recency has
  // detached them from their project. A single Ctrl+` reaches anything.
  const switchTargets = useMemo(() => {
    const out: {
      id: string;
      key: string;
      projectEncoded: string;
      worktreeId: string | null;
      label: string;
      sub?: string;
      worktree: boolean;
    }[] = [];
    for (const p of activeProjects) {
      out.push({
        id: switchTargetId(p.encoded, null),
        key: p.encoded,
        projectEncoded: p.encoded,
        worktreeId: null,
        label: lastSegment(p.cwd),
        sub: p.cwd,
        worktree: false,
      });
      for (const w of allWorktrees.byProject.get(p.encoded) ?? []) {
        out.push({
          id: switchTargetId(p.encoded, w.id),
          key: w.id,
          projectEncoded: p.encoded,
          worktreeId: w.id,
          label: w.name,
          sub: lastSegment(p.cwd),
          worktree: true,
        });
      }
    }
    return orderByMru(SWITCH_MRU_SCOPE, out, (t) => t.id);
    // switchMruVersion is a dep: re-sort when the recency order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjects, allWorktrees.byProject, switchMruVersion]);
  const currentTargetIndex = Math.max(
    0,
    switchTargets.findIndex(
      (t) =>
        t.projectEncoded === selectedEncoded &&
        t.worktreeId === activeWorktreeId,
    ),
  );
  const projectSwitcher = useTabSwitcher({
    id: "projects",
    enabled: switchTargets.length > 1,
    triggerCode: "Backquote",
    items: switchTargets,
    currentIndex: currentTargetIndex,
    onCommit: (t) =>
      t.worktreeId
        ? selectWorktree(t.projectEncoded, t.worktreeId)
        : selectProject(t.projectEncoded),
  });

  // ── Global attention switcher (double-tap Ctrl) ─────────────────────
  // Self-contained in ./attention-switcher; App only supplies the data it
  // already has and the landing action. Deleting the feature = remove that
  // file, this callback, and the <AttentionSwitcher/> mount below.
  const handleAttentionNavigate = useCallback(
    (t: AttentionTarget) => {
      openProjectTab(t.encoded, makeChatTab(t.sessionId));
      if (t.worktreeId) selectWorktree(t.projectEncoded, t.worktreeId);
      else selectProject(t.encoded);
      setDashboardOpen(false);
    },
    [selectWorktree, selectProject],
  );

  return (
    <div className="flex h-screen w-full flex-row overflow-hidden bg-[var(--bg-surface)] text-[var(--text)]">
      {/* App-root toast host — always mounted, so notifications show regardless
          of which project/view is active. */}
      <Toaster position="bottom-right" closeButton />
      <UpdateBanner />
      <ProjectSidebar
        projects={projects}
        reposByProject={reposByProject}
        iconsByProject={iconsByProject}
        worktreesByProject={allWorktrees.byProject}
        selectedProject={selectedEncoded}
        activeWorktreeId={activeWorktreeId}
        onSelectProject={selectProject}
        onSelectWorktree={selectWorktree}
        onNewWorktree={handleNewWorktree}
        onOpenProjectDefaults={handleOpenProjectDefaults}
        onRemoveWorktree={handleRemoveWorktree}
        onCreatePr={setPrWorktreeId}
        onAddRepos={setAddReposWorktreeId}
        onAddProject={handleAddProject}
        onSetArchived={handleSetArchived}
        onOpenDashboard={() => setDashboardOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenClaudeConfig={() => setClaudeConfigScope("project")}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {renderTargets.length > 0 ? (
          // Every mounted target renders a host; only the active one is visible
          // (the rest are display:none). Keyed by encoded so a target keeps its
          // instance across switches — that's the whole point (no remount).
          renderTargets.map((t) => (
            <WorkspaceHost
              key={t.encoded}
              target={t}
              // Visibility follows the DEFERRED target: the old workspace
              // stays on screen (and interactive) until the new one has
              // actually rendered — never a blank flash mid-switch.
              active={t.encoded === deferredTarget?.encoded}
              projects={projects}
              reposByProject={reposByProject}
              worktreeRecord={
                t.worktreeId ? (worktreeById.get(t.worktreeId) ?? null) : null
              }
              worktreesByProject={allWorktrees.byProject}
              projectsSidebarOpen={projectsSidebar.open}
              onSelectProject={selectProject}
              onSelectWorktree={selectWorktree}
              onMoveSession={handleRequestMoveSession}
            />
          ))
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {projects.length === 0
              ? "No Claude projects yet — start a session in one or add a project manually."
              : "Select a project"}
          </div>
        )}
      </main>
      <Suspense fallback={null}>
        {dashboardOpen && (
          <SessionsDashboard
            open
            onClose={() => setDashboardOpen(false)}
            onNavigate={navigateToSession}
          />
        )}
        {settingsOpen && (
          <SettingsModal
            open
            onClose={() => setSettingsOpen(false)}
            onShowShortcuts={() => {
              // Hand off to the focused reference rather than stacking modals
              // (which would make Esc ambiguous).
              setSettingsOpen(false);
              setShortcutsOpen(true);
            }}
          />
        )}
        {shortcutsOpen && (
          <KeyboardShortcutsModal
            open
            onClose={() => setShortcutsOpen(false)}
          />
        )}
        {claudeConfigScope && (
          <ClaudeConfigModal
            encoded={selectedEncoded}
            initialScope={claudeConfigScope}
            onClose={() => setClaudeConfigScope(null)}
          />
        )}
        {showNewWorktree && selected && (
          <NewWorktreeModal
            defaults={worktrees.defaults}
            projectEncoded={selected.encoded}
            onCreate={async (input) => {
              const rec = await worktrees.create(input);
              await allWorktrees.refresh();
              // Opened from "Move to worktree → New worktree…": relocate the
              // chat into the fresh worktree instead of just selecting it.
              if (pendingMoveOnCreate && moveSession) {
                await performMove(rec.encoded, rec.id);
              } else {
                selectWorktreeLocal(rec.id);
              }
            }}
            onClose={() => {
              setShowNewWorktree(false);
              // Abandon a move-in-progress if the user cancelled worktree creation.
              if (pendingMoveOnCreate) {
                setPendingMoveOnCreate(false);
                setMoveSession(null);
              }
            }}
          />
        )}
        {moveSession && !showNewWorktree && (
          <MoveSessionModal
            sessionTitle={moveSession.title}
            targets={moveTargets}
            onPick={(encoded, worktreeId) =>
              void performMove(encoded, worktreeId)
            }
            onNewWorktree={() => {
              setPendingMoveOnCreate(true);
              setShowNewWorktree(true);
            }}
            onClose={() => setMoveSession(null)}
          />
        )}
        {prWorktree && (
          <CreatePrModal
            worktree={prWorktree}
            onCreate={(input) => worktrees.createPr(prWorktree.id, input)}
            onClose={() => setPrWorktreeId(null)}
          />
        )}
        {addReposWorktree && (
          <AddReposModal
            worktree={addReposWorktree}
            projectEncoded={addReposWorktree.projectEncoded}
            onAdd={async (input) => {
              const rec = await worktrees.addRepos(addReposWorktree.id, input);
              await allWorktrees.refresh();
              return rec;
            }}
            onClose={() => setAddReposWorktreeId(null)}
          />
        )}
        {showDefaults && selected && (
          <ProjectDefaultsModal
            encoded={selected.encoded}
            defaults={worktrees.defaults}
            onSave={worktrees.saveDefaults}
            onClose={() => setShowDefaults(false)}
          />
        )}
      </Suspense>
      {projectSwitcher.active && (
        <SwitcherOverlay
          title="Switch to"
          index={projectSwitcher.index}
          items={switchTargets.map((t) => ({
            key: t.key,
            label: t.label,
            sub: t.sub,
            worktree: t.worktree,
          }))}
        />
      )}
      <AttentionSwitcher
        projects={activeProjects}
        worktreesByProject={allWorktrees.byProject}
        onNavigate={handleAttentionNavigate}
      />
      {confirmDialog}
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider
        defaultOpen={true}
        storageKey="plan.projectSidebar.open"
        shortcut={{ key: "b", meta: true }}
      >
        <Shell />
      </SidebarProvider>
    </TooltipProvider>
  );
}
