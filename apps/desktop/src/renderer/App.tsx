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
import { Toaster } from "@plan/shared/components/ui/sonner";
import { SwitcherOverlay } from "./components/switcher-overlay";
import { SessionsDashboard } from "./components/sessions-dashboard";
import { SettingsModal } from "./components/settings-modal";
import { KeyboardShortcutsModal } from "./components/keyboard-shortcuts-modal";
import { ClaudeConfigModal } from "./components/claude-config-modal";
import type { ClaudeConfigScope } from "../shared-types";
import { WorktreeRail } from "./components/worktree-rail";
import { NewWorktreeModal } from "./components/new-worktree-modal";
import { AddReposModal } from "./components/add-repos-modal";
import { CreatePrModal } from "./components/create-pr-modal";
import { ProjectDefaultsModal } from "./components/project-defaults-modal";
import { UpdateBanner } from "./components/update-banner";
import { useConfirm } from "./components/confirm-dialog";
import { useWorktrees } from "./lib/use-worktrees";
import { usePersistentNumber } from "./lib/use-persistent-number";
import { useTabSwitcher } from "./lib/use-tab-switcher";
import { openProjectTab, makeChatTab } from "./lib/tabs-store";
import {
  getMruVersion,
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
      }
    },
    [projects, selectedEncoded],
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
  // Worktree id whose Add-repos modal is open (null = closed).
  const [addReposWorktreeId, setAddReposWorktreeId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setActiveWorktreeId(null);
  }, [selectedEncoded]);

  const activeWorktree =
    worktrees.worktrees.find((w) => w.id === activeWorktreeId) ?? null;
  const prWorktree =
    worktrees.worktrees.find((w) => w.id === prWorktreeId) ?? null;
  const addReposWorktree =
    worktrees.worktrees.find((w) => w.id === addReposWorktreeId) ?? null;

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
    [worktrees, confirm, activeWorktreeId],
  );

  // ⌘E toggles the worktrees rail; persisted like the projects sidebar.
  const [worktreeRailOpen, setWorktreeRailOpen] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.localStorage.getItem("plan.worktreeRail.open") !== "false",
  );
  useEffect(() => {
    window.localStorage.setItem(
      "plan.worktreeRail.open",
      String(worktreeRailOpen),
    );
  }, [worktreeRailOpen]);

  // Drag-to-resize, mirroring the projects sidebar's handle. Width persists so a
  // user's drag sticks across reloads; `resizing` drops the width transition so
  // the column tracks the cursor instead of lagging behind it.
  const [worktreeRailWidth, setWorktreeRailWidth] = usePersistentNumber(
    "plan.worktreeRail.width",
    224,
  );
  const [worktreeRailResizing, setWorktreeRailResizing] = useState(false);
  const startWorktreeRailResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setWorktreeRailResizing(true);
      const startX = e.clientX;
      const startW = worktreeRailWidth;
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(Math.max(startW + (ev.clientX - startX), 200), 420);
        setWorktreeRailWidth(next);
      };
      const onUp = () => {
        setWorktreeRailResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [worktreeRailWidth, setWorktreeRailWidth],
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
      // ⌘D → toggle the worktrees rail. Fires even when a text input or the
      // Lexical chat composer is focused: ⌘D types nothing, so there's no
      // conflict, and bailing on focused inputs made the shortcut feel broken.
      if (e.key.toLowerCase() === "d") {
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
    onCommit: (it) => setActiveWorktreeId(it.id),
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
      setSelectedEncoded(encoded);
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
  const mruVersion = useSyncExternalStore(
    subscribeMru,
    getMruVersion,
    getMruVersion,
  );
  const projectsByMru = useMemo(
    () => orderByMru("projects", activeProjects, (p) => p.encoded),
    [activeProjects, mruVersion],
  );
  useEffect(() => {
    if (selectedEncoded) recordUse("projects", selectedEncoded);
  }, [selectedEncoded]);
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
    onCommit: (p) => setSelectedEncoded(p.encoded),
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
        selected={selectedEncoded}
        onSelect={setSelectedEncoded}
        onAddProject={handleAddProject}
        onSetArchived={handleSetArchived}
        onOpenDashboard={() => setDashboardOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenClaudeConfig={() => setClaudeConfigScope("project")}
      />
      {selected && (
        <div
          data-state={worktreeRailOpen ? "expanded" : "collapsed"}
          className={
            "relative flex h-full shrink-0 flex-col overflow-hidden bg-[var(--bg-surface)] ease-out" +
            // No width transition while dragging — it would lag the handle.
            (worktreeRailResizing ? "" : " transition-[width] duration-200") +
            (worktreeRailOpen ? " border-r border-[var(--border)]" : "")
          }
          style={{ width: worktreeRailOpen ? worktreeRailWidth : 0 }}
        >
          {/* Inner sits at the rail's natural width; the outer column clips it
              as the width animates, so it slides like the other sidebars. */}
          <div
            className="flex h-full flex-col"
            style={{ width: worktreeRailWidth }}
          >
            <WorktreeRail
              trafficLightInset={!projectsSidebar.open}
              projectName={projectShortName(selected)}
              liveBranch={
                reposByProject.get(selected.encoded)?.[0]?.branch ?? null
              }
              worktrees={worktrees.worktrees}
              activeWorktreeId={activeWorktreeId}
              onSelectLive={() => setActiveWorktreeId(null)}
              onSelectWorktree={setActiveWorktreeId}
              onNew={() => setShowNewWorktree(true)}
              onRemove={handleRemoveWorktree}
              onAddRepos={setAddReposWorktreeId}
              onCreatePr={setPrWorktreeId}
              onOpenSettings={() => setShowDefaults(true)}
              projectRepoCount={
                reposByProject.get(selected.encoded)?.length ?? 0
              }
            />
          </div>
          {worktreeRailOpen && (
            <div
              onPointerDown={startWorktreeRailResize}
              title="Drag to resize"
              className={
                "absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-[var(--border-strong)]" +
                (worktreeRailResizing ? " bg-[var(--accent)]" : "")
              }
            />
          )}
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
            // Run command is project-level: keyed by the parent project's
            // defaults, so every worktree of this project shares it.
            runCommand={worktrees.defaults.runCommand}
            buildCommand={worktrees.defaults.buildCommand}
            autoMode={worktrees.defaults.autoMode}
            onSaveRunConfig={(runCommand, buildCommand) =>
              worktrees.saveDefaults({
                ...worktrees.defaults,
                runCommand,
                buildCommand,
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
      <SessionsDashboard
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        onNavigate={navigateToSession}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onShowShortcuts={() => {
          // Hand off to the focused reference rather than stacking modals (which
          // would make Esc ambiguous).
          setSettingsOpen(false);
          setShortcutsOpen(true);
        }}
      />
      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      {claudeConfigScope && (
        <ClaudeConfigModal
          encoded={selectedEncoded}
          initialScope={claudeConfigScope}
          onClose={() => setClaudeConfigScope(null)}
        />
      )}
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
          projectEncoded={selected.encoded}
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
      {addReposWorktree && selected && (
        <AddReposModal
          worktree={addReposWorktree}
          projectEncoded={selected.encoded}
          onAdd={(input) => worktrees.addRepos(addReposWorktree.id, input)}
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
