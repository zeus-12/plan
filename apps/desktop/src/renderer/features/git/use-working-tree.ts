import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnifiedDiff, type FileDiff } from "@plan/shared/lib/diff-parser";
import { lastSegment } from "@plan/shared/lib/path";
import type {
  DiscoveredRepo,
  GitFileStatus,
  GitOpResult,
} from "@/common/shared-types";
import type { FileEntry, RepoFileGroup } from "./file-list";
import {
  getProjectTabs,
  closeProjectTab,
  replaceProjectTab,
  makeDiffTab,
} from "@/renderer/features/workspace/tabs-store";

/**
 * The workspace's view of the git working tree, per repo (a project can hold
 * several repos; every op routes via subPath). Owns the diff/status fetch and
 * its loading discipline, the sidebar's staged/unstaged groups, the sync-bar
 * push targets, and every working-tree operation — each op refreshes so the
 * UI only ever shows what git actually reports, never an assumed outcome.
 *
 * Refreshing also reconciles open diff tabs against the fresh status: an open
 * diff follows its file — it flips sides when the file moves across sections
 * (staging the open diff) and closes when the file is no longer changed — so
 * a diff tab never goes blank. That policy lives here, next to the refresh
 * that triggers it, and acts through the tabs-store module API.
 *
 * Destructive ops (discard file / discard all) gate on the caller's `confirm`.
 */

interface RepoFiles {
  files: FileDiff[];
  status: GitFileStatus[];
  diffAvailable: boolean;
  ahead: number;
  hasUpstream: boolean;
}

/** What one refresh read from git, for callers that report it to the user. */
export interface WorkingTreeSummary {
  /** Changed paths across every repo (a path counts once, as git lists it). */
  changedFiles: number;
  reposWithChanges: number;
  /** Repos in the project, changed or not. */
  repos: number;
}

/** One repo's push-target row for the sync bar. */
export interface SyncTarget {
  subPath: string;
  repoName: string;
  branch: string | null;
  ahead: number;
  hasUpstream: boolean;
  pushing: boolean;
}

export function repoDisplayName(
  repo: DiscoveredRepo,
  projectCwd: string,
): string {
  if (!repo.subPath) return lastSegment(projectCwd);
  return repo.subPath;
}

function letterFromCode(code: string): FileEntry["letter"] | null {
  // X is staged-side, Y is unstaged-side. Pick the most informative.
  const codes = [code[0], code[1]].filter((c) => c && c !== " ");
  for (const c of codes) {
    if (c === "A") return "A";
    if (c === "D") return "D";
    if (c === "M") return "M";
    if (c === "R") return "R";
    if (c === "?") return "?";
  }
  return null;
}

function letterFromDiff(diff?: FileDiff): FileEntry["letter"] {
  if (!diff) return "M";
  switch (diff.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

export function useWorkingTree(opts: {
  encoded: string;
  /** Project root cwd — repo display names derive from it. */
  cwd: string;
  repos: DiscoveredRepo[];
  /** Promise-based confirmation for the destructive discards. */
  confirm: (opts: {
    title: string;
    description?: string;
    confirmLabel?: string;
  }) => Promise<boolean>;
}) {
  const { encoded, cwd, repos, confirm } = opts;

  const [filesByRepo, setFilesByRepo] = useState<Map<string, RepoFiles>>(
    new Map(),
  );
  const [filesLoading, setFilesLoading] = useState(true);
  // True once the first load has populated data. Subsequent refreshes (after a
  // stage/discard/etc.) update in place WITHOUT flipping back to the loading
  // placeholder — that swap unmounts the list and resets its scroll.
  const loadedRef = useRef(false);
  /** subPath currently being pushed (for the sync-bar spinner). */
  const [pushingRepo, setPushingRepo] = useState<string | null>(null);

  /** What the refresh actually read, for callers that report it (the ⌘R
   *  toast names counts, so it must state the fresh numbers rather than the
   *  render-state ones, which land a tick later). */
  const refreshDiff = useCallback(async (): Promise<WorkingTreeSummary> => {
    if (repos.length === 0) {
      setFilesByRepo(new Map());
      setFilesLoading(false);
      loadedRef.current = true;
      return { changedFiles: 0, reposWithChanges: 0, repos: 0 };
    }
    if (!loadedRef.current) setFilesLoading(true);
    try {
      const entries = await Promise.all(
        repos.map(async (r) => {
          const [diff, status] = await Promise.all([
            window.electronAPI.getDiff(encoded, r.subPath),
            window.electronAPI.getGitStatus(encoded, r.subPath),
          ]);
          return [
            r.subPath,
            {
              files: diff.available ? parseUnifiedDiff(diff.diff) : [],
              status: status.files,
              diffAvailable: diff.available,
              ahead: status.ahead,
              hasUpstream: status.hasUpstream,
            },
          ] as const;
        }),
      );
      const next = new Map(entries);
      setFilesByRepo(next);
      // Reconcile open diff tabs against fresh git status. We DON'T auto-open
      // anything — content only opens on explicit click — but an already-open
      // diff tab must follow its file: close it once the file is no longer
      // changed (committed/discarded), and flip its staged side when the file
      // moves across sections (staging the open diff), so it never goes blank.
      for (const t of getProjectTabs(encoded).tabs) {
        if (t.kind !== "diff") continue;
        const status = next
          .get(t.subPath)
          ?.status.find((s) => s.path === t.path);
        if (!status) {
          closeProjectTab(encoded, t.id);
          continue;
        }
        if (t.staged ? status.staged : status.unstaged) continue;
        if (t.staged ? status.unstaged : status.staged) {
          replaceProjectTab(
            encoded,
            t.id,
            makeDiffTab(t.subPath, t.path, !t.staged),
          );
        } else {
          closeProjectTab(encoded, t.id);
        }
      }
      let changedFiles = 0;
      let reposWithChanges = 0;
      for (const state of next.values()) {
        if (state.status.length === 0) continue;
        changedFiles += state.status.length;
        reposWithChanges += 1;
      }
      return { changedFiles, reposWithChanges, repos: repos.length };
    } finally {
      loadedRef.current = true;
      setFilesLoading(false);
    }
  }, [encoded, repos]);

  // Initial load (and reload when the repo set changes). Comments and open
  // tabs are intentionally NOT touched here — they persist per worktree.
  useEffect(() => {
    refreshDiff();
  }, [refreshDiff]);

  /**
   * Per-repo {staged, unstaged} groups for the sidebar file list. Built from
   * each repo's status + diff. When there's only one repo we still produce
   * one group; the FileList collapses single-group rendering to flat.
   */
  const repoGroups: RepoFileGroup[] = useMemo(() => {
    return repos.map((repo) => {
      const state = filesByRepo.get(repo.subPath);
      if (!state) {
        return {
          subPath: repo.subPath,
          repoName: repoDisplayName(repo, cwd),
          branch: repo.branch,
          staged: [],
          unstaged: [],
          diffAvailable: true,
        };
      }
      const diffByPath = new Map(state.files.map((f) => [f.path, f]));
      const staged: FileEntry[] = [];
      const unstaged: FileEntry[] = [];
      for (const s of state.status) {
        const diff = diffByPath.get(s.path);
        const letter = letterFromCode(s.code) ?? letterFromDiff(diff);
        const base = {
          path: s.path,
          code: s.code,
          letter,
          additions: diff?.additions,
          deletions: diff?.deletions,
          subPath: repo.subPath,
        };
        if (s.staged) staged.push({ ...base, staged: true });
        if (s.unstaged) unstaged.push({ ...base, staged: false });
      }
      return {
        subPath: repo.subPath,
        repoName: repoDisplayName(repo, cwd),
        branch: repo.branch,
        staged,
        unstaged,
        diffAvailable: state.diffAvailable,
      };
    });
  }, [repos, filesByRepo, cwd]);

  // Per-repo push targets for the sync bar (only repos with an upstream or
  // unpushed commits are worth showing).
  const syncTargets: SyncTarget[] = useMemo(
    () =>
      repos
        .map((repo) => {
          const state = filesByRepo.get(repo.subPath);
          return {
            subPath: repo.subPath,
            repoName: repoDisplayName(repo, cwd),
            branch: repo.branch,
            ahead: state?.ahead ?? 0,
            hasUpstream: state?.hasUpstream ?? false,
            pushing: pushingRepo === repo.subPath,
          };
        })
        .filter((t) => t.hasUpstream || t.ahead > 0),
    [repos, filesByRepo, cwd, pushingRepo],
  );

  /**
   * Stage-status lookup for a project-relative path: which repo owns it and
   * which stages currently hold changes. Null when the file isn't changed.
   */
  const fileStages = useCallback(
    (
      projectRelPath: string,
    ): {
      subPath: string;
      path: string;
      staged: boolean;
      unstaged: boolean;
    } | null => {
      for (const [sp, state] of filesByRepo) {
        const match = state.status.find(
          (s) => (sp ? `${sp}/${s.path}` : s.path) === projectRelPath,
        );
        if (match) {
          return {
            subPath: sp,
            path: match.path,
            staged: match.staged,
            unstaged: match.unstaged,
          };
        }
      }
      return null;
    },
    [filesByRepo],
  );

  /**
   * The FileDiff for a (subPath, path). Untracked files (and any status entry
   * that `git diff HEAD` doesn't emit) get a synthetic FileDiff so they still
   * open in the viewer — FileDiffViewer fetches the actual content itself.
   */
  const getFileDiff = useCallback(
    (subPath: string, path: string): FileDiff | null => {
      const repo = filesByRepo.get(subPath);
      if (!repo) return null;
      const fromDiff = repo.files.find((f) => f.path === path);
      if (fromDiff) return fromDiff;

      // Not in the diff — synthesize from the status entry.
      const status = repo.status.find((s) => s.path === path);
      if (!status) return null;
      const isDeleted = status.code.includes("D");
      const isUntracked = status.code === "??";
      const statusKind: FileDiff["status"] = isDeleted
        ? "deleted"
        : isUntracked
          ? "added"
          : "modified";
      return {
        path,
        oldPath: isUntracked ? null : path,
        newPath: isDeleted ? null : path,
        status: statusKind,
        body: "",
        additions: 0,
        deletions: 0,
        binary: false,
      };
    },
    [filesByRepo],
  );

  // ── Working-tree ops (each refreshes; git's answer is the UI's truth) ──

  const stageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.stageFile(encoded, path, subPath);
      if (!res.ok) console.warn("stage failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff],
  );

  const unstageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.unstageFile(encoded, path, subPath);
      if (!res.ok) console.warn("unstage failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff],
  );

  const discardFile = useCallback(
    async (path: string, subPath: string) => {
      const ok = await confirm({
        title: `Discard changes to ${path.split("/").pop() ?? path}?`,
        description:
          "This permanently discards your local changes to this file. It cannot be undone.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
      const res = await window.electronAPI.discardFile(encoded, path, subPath);
      if (!res.ok) console.warn("discard failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff, confirm],
  );

  const stageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.stageAll(encoded, subPath);
      if (!res.ok) console.warn("stage all failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff],
  );

  const unstageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.unstageAll(encoded, subPath);
      if (!res.ok) console.warn("unstage all failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff],
  );

  const discardAll = useCallback(
    async (subPath: string) => {
      const ok = await confirm({
        title: "Discard all changes?",
        description:
          "This permanently discards every unstaged change and removes untracked files in this repo. It cannot be undone.",
        confirmLabel: "Discard all",
      });
      if (!ok) return;
      const res = await window.electronAPI.discardAll(encoded, subPath);
      if (!res.ok) console.warn("discard all failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff, confirm],
  );

  const stashAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.stashAll(encoded, subPath);
      if (!res.ok) console.warn("stash all failed:", res.error);
      refreshDiff();
    },
    [encoded, refreshDiff],
  );

  const push = useCallback(
    async (subPath: string): Promise<GitOpResult> => {
      setPushingRepo(subPath);
      try {
        const res = await window.electronAPI.push(encoded, subPath);
        await refreshDiff();
        return res;
      } finally {
        setPushingRepo(null);
      }
    },
    [encoded, refreshDiff],
  );

  const commit = useCallback(
    async (
      message: string,
      subPath: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const res = await window.electronAPI.commit(encoded, message, subPath);
      if (!res.ok) return { ok: false, error: res.error ?? "Commit failed" };
      refreshDiff();
      return { ok: true };
    },
    [encoded, refreshDiff],
  );

  return {
    filesLoading,
    refreshDiff,
    repoGroups,
    syncTargets,
    fileStages,
    getFileDiff,
    stageFile,
    unstageFile,
    discardFile,
    stageAll,
    unstageAll,
    discardAll,
    stashAll,
    push,
    commit,
  };
}
