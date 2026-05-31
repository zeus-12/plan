import { useCallback, useEffect, useState } from "react";
import {
  SidebarProvider,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { TooltipProvider } from "@plan/shared/components/ui/tooltip";
import type { DiscoveredRepo, ProjectEntry } from "../shared-types";
import { ProjectSidebar } from "./components/projectSidebar";
import { ProjectWorkspace } from "./components/projectWorkspace";

function Shell() {
  const projectsSidebar = useSidebar();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [selectedEncoded, setSelectedEncoded] = useState<string | null>(null);
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
      if (current && list.some((p) => p.encoded === current)) return current;
      const firstActive = list.find((p) => !p.archived);
      return firstActive?.encoded ?? list[0]?.encoded ?? null;
    });
    void refreshRepos(list);
  }, [refreshRepos]);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    return window.electronAPI.onWatcherEvent((e) => {
      refreshProjects();
      if (e.kind === "new-session") {
        setSelectedEncoded(e.encoded);
      }
    });
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

  return (
    <div className="flex h-screen w-screen flex-row bg-[var(--bg)] text-[var(--text)]">
      <ProjectSidebar
        projects={projects}
        reposByProject={reposByProject}
        selected={selectedEncoded}
        onSelect={setSelectedEncoded}
        onAddProject={handleAddProject}
        onSetArchived={handleSetArchived}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <ProjectWorkspace
            key={selected.encoded}
            project={selected}
            repos={reposByProject.get(selected.encoded) ?? []}
            projectsSidebarOpen={projectsSidebar.open}
            onToggleProjectSidebar={projectsSidebar.toggle}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {projects.length === 0
              ? "No Claude projects yet — start a session in one or add a project manually."
              : "Select a project"}
          </div>
        )}
      </main>
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
