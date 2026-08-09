import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import type {
  DiscoveredRepo,
  ProjectEntry,
  WorktreeRecord,
} from "@/common/shared-types";
import { ProjectWorkspace } from "./project-workspace";
import { useWorktrees } from "@/renderer/features/worktrees/use-worktrees";
import {
  runEntriesOf,
  buildEntriesOf,
  scriptEntriesOf,
} from "@/renderer/features/terminal/commands";
import {
  getCachedWorktreeRepos,
  setCachedWorktreeRepos,
} from "@/renderer/features/worktrees/worktree-repos-cache";

/**
 * A destination the workspace pool can mount: a project's working copy
 * (`worktreeId: null`, `encoded === projectEncoded`) or one of its worktrees
 * (`encoded` is the worktree's own encoded; `projectEncoded` is the parent,
 * whose defaults drive the Run/Build lists shared across its worktrees).
 */
export interface MountTarget {
  encoded: string;
  projectEncoded: string;
  worktreeId: string | null;
}

const EMPTY_REPOS: DiscoveredRepo[] = [];

interface Props {
  target: MountTarget;
  /** Whether this host is the one on screen (drives visibility + input gating). */
  active: boolean;
  /** All projects — for the ⌘K palette and resolving a working copy's entry. */
  projects: ProjectEntry[];
  /** Working-copy repos, keyed by project encoded. */
  reposByProject: Map<string, DiscoveredRepo[]>;
  /** The record for a worktree target (null for a working copy). */
  worktreeRecord: WorktreeRecord | null;
  /** Every project's worktrees (keyed by parent encoded) — for the ⌘K palette. */
  worktreesByProject: Map<string, WorktreeRecord[]>;
  projectsSidebarOpen: boolean;
  onSelectProject: (encoded: string) => void;
  onSelectWorktree: (projectEncoded: string, worktreeId: string) => void;
  onMoveSession: (sessionId: string, title: string) => void;
}

/**
 * Resolves one {@link MountTarget}'s data (its `project`, repos, and the
 * project-level Run/Build lists) and renders a `ProjectWorkspace` for it. One
 * host per mounted target; App keeps recently-visited hosts mounted and hides
 * the inactive ones, so switching back is instant.
 *
 * Memoized so that when App re-renders (a watcher tick, a switch to another
 * target) a host only re-renders if ITS OWN props changed — a pure switch flips
 * `active` on just the two involved hosts and leaves the rest untouched. That,
 * plus `ProjectWorkspace` itself being memoized, is what keeps a switch from
 * re-rendering every mounted workspace.
 */
function WorkspaceHostImpl({
  target,
  active,
  projects,
  reposByProject,
  worktreeRecord,
  worktreesByProject,
  projectsSidebarOpen,
  onSelectProject,
  onSelectWorktree,
  onMoveSession,
}: Props) {
  const isWorktree = target.worktreeId != null;
  const wt = useWorktrees(target.projectEncoded);

  const runEntries = useMemo(() => runEntriesOf(wt.defaults), [wt.defaults]);
  const buildEntries = useMemo(
    () => buildEntriesOf(wt.defaults),
    [wt.defaults],
  );
  const scriptEntries = useMemo(
    () => scriptEntriesOf(wt.defaults),
    [wt.defaults],
  );
  const onSaveRun = useCallback(
    (runCommands: ReturnType<typeof runEntriesOf>) =>
      wt.saveDefaults((current) => ({
        ...current,
        runCommands,
        runCommand: undefined,
      })),
    [wt],
  );
  const onSaveBuild = useCallback(
    (buildCommands: ReturnType<typeof buildEntriesOf>) =>
      wt.saveDefaults((current) => ({
        ...current,
        buildCommands,
        buildCommand: undefined,
      })),
    [wt],
  );
  const onSaveScripts = useCallback(
    (scripts: ReturnType<typeof scriptEntriesOf>) =>
      wt.saveDefaults((current) => ({ ...current, scripts })),
    [wt],
  );

  // A worktree resolves its own repos (a working copy's come from the app-wide
  // map). Seed from the shared cache so a re-mounted worktree paints with repos
  // immediately, then refresh in the background.
  const [wtRepos, setWtRepos] = useState<DiscoveredRepo[]>(() =>
    isWorktree
      ? (getCachedWorktreeRepos(target.encoded) ?? EMPTY_REPOS)
      : EMPTY_REPOS,
  );
  const worktreeRepoCount = worktreeRecord?.repos.length;
  useEffect(() => {
    if (!isWorktree) return;
    const enc = target.encoded;
    const cached = getCachedWorktreeRepos(enc);
    if (cached) setWtRepos(cached);
    let cancelled = false;
    window.electronAPI.listRepos(enc).then((r) => {
      setCachedWorktreeRepos(enc, r);
      if (!cancelled) setWtRepos(r);
    });
    return () => {
      cancelled = true;
    };
    // Re-list when repos are added to this worktree (record grows, encoded same).
  }, [isWorktree, target.encoded, worktreeRepoCount]);

  // Synthesize a worktree's ProjectEntry (a worktree is just another cwd), or
  // look up the working copy's real entry. Memoized so its identity is stable
  // across App re-renders — otherwise it would defeat ProjectWorkspace's memo.
  const project = useMemo<ProjectEntry | null>(() => {
    if (isWorktree) {
      if (!worktreeRecord) return null;
      return {
        encoded: worktreeRecord.encoded,
        cwd: worktreeRecord.rootPath,
        mtimeMs: worktreeRecord.mtimeMs,
        archived: false,
      };
    }
    return projects.find((p) => p.encoded === target.projectEncoded) ?? null;
  }, [
    isWorktree,
    worktreeRecord?.encoded,
    worktreeRecord?.rootPath,
    worktreeRecord?.mtimeMs,
    projects,
    target.projectEncoded,
  ]);

  const repos = isWorktree
    ? wtRepos
    : (reposByProject.get(target.encoded) ?? EMPTY_REPOS);

  return (
    <div
      className={cn(
        "min-h-0 min-w-0 flex-1 flex-col",
        active ? "flex" : "hidden",
      )}
    >
      {project ? (
        <ProjectWorkspace
          project={project}
          repos={repos}
          active={active}
          projectsSidebarOpen={projectsSidebarOpen}
          projects={projects}
          onSelectProject={onSelectProject}
          worktreesByProject={worktreesByProject}
          onSelectWorktree={onSelectWorktree}
          runEntries={runEntries}
          buildEntries={buildEntries}
          scriptEntries={scriptEntries}
          isWorktree={isWorktree}
          onSaveRun={onSaveRun}
          onSaveBuild={onSaveBuild}
          onSaveScripts={onSaveScripts}
          onMoveSession={onMoveSession}
        />
      ) : null}
    </div>
  );
}

export const WorkspaceHost = memo(WorkspaceHostImpl);
