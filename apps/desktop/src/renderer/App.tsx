import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SidebarProvider,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { TooltipProvider } from "@plan/shared/components/ui/tooltip";
import type { DiscoveredRepo, ProjectEntry } from "../shared-types";
import { ProjectSidebar } from "./components/project-sidebar";
import { ProjectWorkspace } from "./components/project-workspace";
import { runEntriesOf, buildEntriesOf } from "./lib/commands";
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
import { useConfirm } from "./components/confirm-dialog";
import { useWorktrees } from "./lib/use-worktrees";
import { useAllWorktrees } from "./lib/use-all-worktrees";
import { useTabSwitcher } from "./lib/use-tab-switcher";
import { openProjectTab, makeChatTab } from "./lib/tabs-store";
import {
  getMruScopeVersion,
  orderByMru,
  recordUse,
  subscribeMru,
} from "./lib/mru-store";
import {
  setSessionLabelResolver,
  setSessionNavigator,
  startSessionDoneNotifier,
} from "./lib/session-done-notifier";

const SELECTED_PROJECT_KEY = "plan.selectedProject";

// Stable getSnapshot for useSyncExternalStore — reads only the "projects" scope.
const getProjectsMruVersion = () => getMruScopeVersion("projects");

function projectShortName(p: ProjectEntry): string {
  return p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
}

function Shell() {
  const projectsSidebar = useSidebar();
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

  /**
   * Discover repos for every project in parallel. The result drives:
   *   - sidebar branch labels (we pick the first repo's branch),
   *   - sidebar grouping (worktrees share a git common dir), and
   *   - the multi-repo file view inside the workspace.
   */
  const refreshRepos = useCallback(async (list: ProjectEntry[]) => {
    const entries = await Promise.all(
      list.map(async (p) => {
        try {
          const repos = await window.electronAPI.listRepos(p.encoded);
          return [p.encoded, repos] as const;
        } catch {
          return [p.encoded, [] as DiscoveredRepo[]] as const;
        }
      }),
    );
    setReposByProject(new Map(entries));
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await window.electronAPI.listProjects();
    setProjects(list);
    setSelectedEncoded((current) => {
      // Keep the current selection; only fall back when it's gone (or unset).
      if (current && list.some((p) => p.encoded === current)) return current;
      const stored = window.localStorage.getItem(SELECTED_PROJECT_KEY);
      if (stored && list.some((p) => p.encoded === stored)) return stored;
      return list.find((p) => !p.archived)?.encoded ?? list[0]?.encoded ?? null;
    });
    void refreshRepos(list);
  }, [refreshRepos]);

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
    // focused — switching out from under the user is jarring.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.electronAPI.onWatcherEvent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshProjects();
      }, 500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refreshProjects]);

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
  // null = the live working copy (the real checkout).
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);
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

  // Switching worktrees remounts the workspace (keyed by encoded), so mark it a
  // transition: React renders the new worktree concurrently while the current
  // one stays interactive, instead of the window freezing mid-switch.
  // Local = within the selected project (live-copy toggle, ⌘1 switcher).
  const selectWorktreeLocal = useCallback((id: string | null) => {
    startTransition(() => setActiveWorktreeId(id));
  }, []);
  // Cross-project = clicking a worktree under any project in the sidebar. Sets
  // both project + worktree atomically so neither clobbers the other.
  const selectWorktree = useCallback(
    (projectEncoded: string, id: string) => {
      startTransition(() => {
        setSelectedEncoded(projectEncoded);
        setActiveWorktreeId(id);
      });
    },
    [],
  );

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

  const activeWorktree =
    worktrees.worktrees.find((w) => w.id === activeWorktreeId) ?? null;
  const prWorktree = prWorktreeId
    ? (worktreeById.get(prWorktreeId) ?? null)
    : null;
  const addReposWorktree = addReposWorktreeId
    ? (worktreeById.get(addReposWorktreeId) ?? null)
    : null;

  // A worktree is just another cwd; the backend primed its `encoded`, so we
  // hand ProjectWorkspace a synthesized project + the worktree's own repos and
  // it scopes everything to the worktree without any changes inside it.
  const [worktreeRepos, setWorktreeRepos] = useState<DiscoveredRepo[]>([]);
  useEffect(() => {
    if (!activeWorktree) {
      setWorktreeRepos([]);
      return;
    }
    let cancelled = false;
    window.electronAPI.listRepos(activeWorktree.encoded).then((r) => {
      if (!cancelled) setWorktreeRepos(r);
    });
    return () => {
      cancelled = true;
    };
    // Re-list when repos are added to this worktree (record grows but encoded
    // stays the same), so the new checkout shows without reselecting.
  }, [activeWorktree?.encoded, activeWorktree?.repos.length]);

  const effectiveProject: ProjectEntry | null = activeWorktree
    ? {
        encoded: activeWorktree.encoded,
        cwd: activeWorktree.rootPath,
        mtimeMs: activeWorktree.createdAt,
        archived: false,
      }
    : selected;
  const effectiveRepos = activeWorktree
    ? worktreeRepos
    : (reposByProject.get(selectedEncoded ?? "") ?? []);

  const handleRemoveWorktree = useCallback(
    async (id: string) => {
      const wt = worktreeById.get(id);
      const ok = await confirm({
        title: `Remove worktree "${wt?.name ?? ""}"?`,
        description:
          "This deletes the worktree's checkouts and branches-in-progress for every repo. Uncommitted work in it is lost.",
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

  // Ctrl+1 cycles the live working copy + this project's worktrees, reusing the
  // same modifier-held switcher as projects (Ctrl+`) and sessions (Ctrl+Tab).
  const worktreeItems = useMemo(
    () => [
      {
        key: "__live__",
        id: null as string | null,
        label: selected ? projectShortName(selected) : "working copy",
      },
      ...worktrees.worktrees.map((w) => ({
        key: w.id,
        id: w.id as string | null,
        label: w.name,
      })),
    ],
    [selected, worktrees.worktrees],
  );
  const worktreeIndex = Math.max(
    0,
    worktreeItems.findIndex((it) => it.id === activeWorktreeId),
  );
  const worktreeSwitcher = useTabSwitcher({
    id: "worktrees",
    enabled: !!selected && worktreeItems.length > 1,
    triggerCode: "Digit1",
    items: worktreeItems,
    currentIndex: worktreeIndex,
    onCommit: (it) => selectWorktreeLocal(it.id),
  });

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
  // Keep the notification body's project label in sync with the project list.
  useEffect(() => {
    const byEncoded = new Map(
      projects.map((p) => [p.encoded, projectShortName(p)]),
    );
    setSessionLabelResolver((id) => {
      const m = id.match(/^chat:(.+):([^:]+)$/);
      if (!m) return "Claude";
      const name = byEncoded.get(m[1]);
      const sid = m[2].slice(0, 8);
      return name ? `${name} · ${sid}` : sid;
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

  // Ctrl+` : cycle projects in a modal, commit on Ctrl-release (Shift reverses).
  // Ordered most-recently-USED first (Alt-Tab style) so the current project
  // sits at top and the first tap lands on the one you were last in. Before any
  // project has been used this session it falls back to mtime recency. Archived
  // projects are excluded — you can't switch to one you've hidden.
  const activeProjects = useMemo(
    () =>
      projects.filter((p) => !p.archived).sort((a, b) => b.mtimeMs - a.mtimeMs),
    [projects],
  );
  // Subscribe to the "projects" scope only — a content-tab or chat switch in
  // the workspace bumps a different scope and must not re-render App/sidebar.
  const projectsMruVersion = useSyncExternalStore(
    subscribeMru,
    getProjectsMruVersion,
    getProjectsMruVersion,
  );
  const projectsByMru = useMemo(
    () => orderByMru("projects", activeProjects, (p) => p.encoded),
    [activeProjects, projectsMruVersion],
  );
  useEffect(() => {
    if (selectedEncoded) recordUse("projects", selectedEncoded);
  }, [selectedEncoded]);

  // Switching projects remounts the whole workspace (keyed by encoded) and
  // mounts the target's tabs — a big file's viewer, terminals, etc. Mark it a
  // transition so React renders the new workspace concurrently: the current
  // project stays interactive instead of the window freezing until the new one
  // is ready (the "Cmd+` hangs / had to alt-tab" symptom).
  const selectProject = useCallback((encoded: string | null) => {
    startTransition(() => {
      setSelectedEncoded(encoded);
      // Selecting a project lands on its live working copy.
      setActiveWorktreeId(null);
    });
  }, []);

  const projectIndex = Math.max(
    0,
    projectsByMru.findIndex((p) => p.encoded === selectedEncoded),
  );
  const projectSwitcher = useTabSwitcher({
    id: "projects",
    enabled: projectsByMru.length > 1,
    triggerCode: "Backquote",
    items: projectsByMru,
    currentIndex: projectIndex,
    onCommit: (p) => selectProject(p.encoded),
  });

  return (
    <div className="flex h-screen w-full flex-row overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* App-root toast host — always mounted, so notifications show regardless
          of which project/view is active. */}
      <Toaster position="bottom-right" closeButton />
      <UpdateBanner />
      <ProjectSidebar
        projects={projects}
        reposByProject={reposByProject}
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
        {effectiveProject ? (
          <ProjectWorkspace
            key={effectiveProject.encoded}
            project={effectiveProject}
            repos={effectiveRepos}
            projectsSidebarOpen={projectsSidebar.open}
            projects={projects}
            onSelectProject={selectProject}
            // Run/Build command lists are project-level: keyed by the parent
            // project's defaults, so every worktree of this project shares them.
            runEntries={runEntriesOf(worktrees.defaults)}
            buildEntries={buildEntriesOf(worktrees.defaults)}
            isWorktree={activeWorktree != null}
            onSaveRun={(runCommands) =>
              worktrees.saveDefaults({
                ...worktrees.defaults,
                runCommands,
                runCommand: undefined,
              })
            }
            onSaveBuild={(buildCommands) =>
              worktrees.saveDefaults({
                ...worktrees.defaults,
                buildCommands,
                buildCommand: undefined,
              })
            }
          />
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
              selectWorktreeLocal(rec.id);
            }}
            onClose={() => setShowNewWorktree(false)}
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
          title="Projects"
          index={projectSwitcher.index}
          items={projectsByMru.map((p) => ({
            key: p.encoded,
            label: projectShortName(p),
            sub: p.cwd,
          }))}
        />
      )}
      {worktreeSwitcher.active && (
        <SwitcherOverlay
          title="Worktrees"
          index={worktreeSwitcher.index}
          items={worktreeItems.map((it) => ({
            key: it.key,
            label: it.label,
            sub: it.id ? "worktree" : "working copy",
          }))}
        />
      )}
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
