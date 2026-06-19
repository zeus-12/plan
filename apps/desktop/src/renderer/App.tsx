import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useTabSwitcher } from "./lib/use-tab-switcher";
import { requestSessionNav } from "./lib/session-nav-store";

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

  // Sessions dashboard: a control-center for every live Claude pty.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const navigateToSession = useCallback(
    (encoded: string, sessionId: string) => {
      // Persist the target so the workspace selects it on (re)mount when we
      // switch project; notify the store for the already-open-project case.
      window.localStorage.setItem(`plan.session.${encoded}`, sessionId);
      setSelectedEncoded(encoded);
      requestSessionNav(encoded, sessionId);
      setDashboardOpen(false);
    },
    []
  );

  // Ctrl+Tab: cycle projects in a modal, commit on Ctrl-release. Ordered
  // most-recently-active first (same recency signal the sidebar sorts by), so
  // the current project sits at top and the first Tab lands on the one below.
  // Archived projects are excluded — you can't switch to one you've hidden.
  const projectsByRecency = useMemo(
    () =>
      projects
        .filter((p) => !p.archived)
        .sort((a, b) => b.mtimeMs - a.mtimeMs),
    [projects]
  );
  const projectIndex = Math.max(
    0,
    projectsByRecency.findIndex((p) => p.encoded === selectedEncoded)
  );
  const projectSwitcher = useTabSwitcher({
    id: "projects",
    enabled: projectsByRecency.length > 1,
    requireShift: false,
    items: projectsByRecency,
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
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <ProjectWorkspace
            key={selected.encoded}
            project={selected}
            repos={reposByProject.get(selected.encoded) ?? []}
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
          items={projectsByRecency.map((p) => ({
            key: p.encoded,
            label: projectShortName(p),
            sub: p.cwd,
          }))}
        />
      )}
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
