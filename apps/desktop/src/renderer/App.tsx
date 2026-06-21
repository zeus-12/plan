import {
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
import { SwitcherOverlay } from "./components/switcher-overlay";
import { SessionsDashboard } from "./components/sessions-dashboard";
import { WorktreeRail } from "./components/worktree-rail";
import { NewWorktreeModal } from "./components/new-worktree-modal";
import { CreatePrModal } from "./components/create-pr-modal";
import { ProjectDefaultsModal } from "./components/project-defaults-modal";
import { useConfirm } from "./components/confirm-dialog";
import { useWorktrees } from "./lib/use-worktrees";
import { useTabSwitcher } from "./lib/use-tab-switcher";
import { openProjectTab, makeChatTab } from "./lib/tabs-store";
import { getMruVersion, orderByMru, recordUse, subscribeMru } from "./lib/mru-store";

const SELECTED_PROJECT_KEY = "plan.selectedProject";

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
      : window.localStorage.getItem(SELECTED_PROJECT_KEY)
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
      })
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
    }
  }, [refreshProjects]);

  const handleSetArchived = useCallback(
    async (encoded: string, archived: boolean) => {
      await window.electronAPI.setProjectArchived(encoded, archived);
      // Reflect in local state immediately so the row moves between sections.
      setProjects((prev) =>
        prev.map((p) => (p.encoded === encoded ? { ...p, archived } : p))
      );
      // If we just archived the selected project, jump to the first active one.
      if (archived && selectedEncoded === encoded) {
        const fallback = projects.find(
          (p) => p.encoded !== encoded && !p.archived
        );
        setSelectedEncoded(fallback ? fallback.encoded : null);
      }
    },
    [projects, selectedEncoded]
  );

  const selected = projects.find((p) => p.encoded === selectedEncoded) ?? null;

  // ── Worktrees (scoped to the selected project) ──────────────────────
  const { confirm, dialog: confirmDialog } = useConfirm();
  const worktrees = useWorktrees(selectedEncoded ?? "");
  // null = the live working copy (the real checkout). Reset on project switch.
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  // Worktree id whose Create-PR modal is open (null = closed).
  const [prWorktreeId, setPrWorktreeId] = useState<string | null>(null);
  useEffect(() => {
    setActiveWorktreeId(null);
  }, [selectedEncoded]);

  const activeWorktree =
    worktrees.worktrees.find((w) => w.id === activeWorktreeId) ?? null;
  const prWorktree =
    worktrees.worktrees.find((w) => w.id === prWorktreeId) ?? null;

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
  }, [activeWorktree?.encoded]);

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
    : reposByProject.get(selectedEncoded ?? "") ?? [];

  const handleRemoveWorktree = useCallback(
    async (id: string) => {
      const wt = worktrees.worktrees.find((w) => w.id === id);
      const ok = await confirm({
        title: `Remove worktree "${wt?.name ?? ""}"?`,
        description:
          "This deletes the worktree's checkouts and branches-in-progress for every repo. Uncommitted work in it is lost.",
        confirmLabel: "Remove worktree",
      });
      if (!ok) return;
      if (activeWorktreeId === id) setActiveWorktreeId(null);
      await worktrees.remove(id);
    },
    [worktrees, confirm, activeWorktreeId]
  );

  // ⌘E toggles the worktrees rail; persisted like the projects sidebar.
  const [worktreeRailOpen, setWorktreeRailOpen] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.localStorage.getItem("plan.worktreeRail.open") !== "false"
  );
  useEffect(() => {
    window.localStorage.setItem(
      "plan.worktreeRail.open",
      String(worktreeRailOpen)
    );
  }, [worktreeRailOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "d"
      ) {
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
        e.preventDefault();
        setWorktreeRailOpen((v) => !v);
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
    [selected, worktrees.worktrees]
  );
  const worktreeIndex = Math.max(
    0,
    worktreeItems.findIndex((it) => it.id === activeWorktreeId)
  );
  const worktreeSwitcher = useTabSwitcher({
    id: "worktrees",
    enabled: !!selected && worktreeItems.length > 1,
    triggerCode: "Digit1",
    items: worktreeItems,
    currentIndex: worktreeIndex,
    onCommit: (it) => setActiveWorktreeId(it.id),
  });

  // Sessions dashboard: a control-center for every live Claude pty.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const navigateToSession = useCallback(
    (encoded: string, sessionId: string) => {
      // Open (or focus) the chat as a tab in the target worktree. This persists
      // to the tabs store, so it works whether that worktree is already mounted
      // (the store emit re-renders it) or not (it's read on mount).
      openProjectTab(encoded, makeChatTab(sessionId));
      setSelectedEncoded(encoded);
      setDashboardOpen(false);
    },
    []
  );

  // Ctrl+` : cycle projects in a modal, commit on Ctrl-release (Shift reverses).
  // Ordered most-recently-USED first (Alt-Tab style) so the current project
  // sits at top and the first tap lands on the one you were last in. Before any
  // project has been used this session it falls back to mtime recency. Archived
  // projects are excluded — you can't switch to one you've hidden.
  const activeProjects = useMemo(
    () =>
      projects
        .filter((p) => !p.archived)
        .sort((a, b) => b.mtimeMs - a.mtimeMs),
    [projects]
  );
  const mruVersion = useSyncExternalStore(
    subscribeMru,
    getMruVersion,
    getMruVersion
  );
  const projectsByMru = useMemo(
    () => orderByMru("projects", activeProjects, (p) => p.encoded),
    [activeProjects, mruVersion]
  );
  useEffect(() => {
    if (selectedEncoded) recordUse("projects", selectedEncoded);
  }, [selectedEncoded]);
  const projectIndex = Math.max(
    0,
    projectsByMru.findIndex((p) => p.encoded === selectedEncoded)
  );
  const projectSwitcher = useTabSwitcher({
    id: "projects",
    enabled: projectsByMru.length > 1,
    triggerCode: "Backquote",
    items: projectsByMru,
    currentIndex: projectIndex,
    onCommit: (p) => setSelectedEncoded(p.encoded),
  });

  return (
    <div className="flex h-screen w-full flex-row overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <ProjectSidebar
        projects={projects}
        reposByProject={reposByProject}
        selected={selectedEncoded}
        onSelect={setSelectedEncoded}
        onAddProject={handleAddProject}
        onSetArchived={handleSetArchived}
        onOpenDashboard={() => setDashboardOpen(true)}
      />
      {selected && worktreeRailOpen && (
        <div className="flex w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-surface)]">
          <WorktreeRail
            trafficLightInset={!projectsSidebar.open}
            projectName={projectShortName(selected)}
            liveBranch={reposByProject.get(selected.encoded)?.[0]?.branch ?? null}
            worktrees={worktrees.worktrees}
            activeWorktreeId={activeWorktreeId}
            onSelectLive={() => setActiveWorktreeId(null)}
            onSelectWorktree={setActiveWorktreeId}
            onNew={() => setShowNewWorktree(true)}
            onRemove={handleRemoveWorktree}
            onCreatePr={setPrWorktreeId}
            onOpenSettings={() => setShowDefaults(true)}
          />
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {effectiveProject ? (
          <ProjectWorkspace
            key={effectiveProject.encoded}
            project={effectiveProject}
            repos={effectiveRepos}
            projectsSidebarOpen={projectsSidebar.open}
            projects={projects}
            onSelectProject={setSelectedEncoded}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {projects.length === 0
              ? "No Claude projects yet — start a session in one or add a project manually."
              : "Select a project"}
          </div>
        )}
      </main>
      <SessionsDashboard
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        onNavigate={navigateToSession}
      />
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
      {showNewWorktree && selected && (
        <NewWorktreeModal
          defaults={worktrees.defaults}
          onCreate={async (input) => {
            const rec = await worktrees.create(input);
            setActiveWorktreeId(rec.id);
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
      {showDefaults && selected && (
        <ProjectDefaultsModal
          encoded={selected.encoded}
          defaults={worktrees.defaults}
          onSave={worktrees.saveDefaults}
          onClose={() => setShowDefaults(false)}
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
