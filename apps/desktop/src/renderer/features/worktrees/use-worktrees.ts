import { useCallback, useEffect, useState } from "react";
import type {
  WorktreeRecord,
  ProjectDefaults,
  CreateWorktreeInput,
  AddReposToWorktreeInput,
  CreatePrInput,
  CreatePrResult,
} from "@/common/shared-types";

export interface UseWorktrees {
  worktrees: WorktreeRecord[];
  loading: boolean;
  refresh: () => Promise<void>;
  create: (input: CreateWorktreeInput) => Promise<WorktreeRecord>;
  remove: (id: string) => Promise<void>;
  addRepos: (
    id: string,
    input: AddReposToWorktreeInput,
  ) => Promise<WorktreeRecord>;
  createPr: (id: string, input: CreatePrInput) => Promise<CreatePrResult>;
  defaults: ProjectDefaults;
  /** Patch the stored defaults; `current` is read fresh, never this hook's copy. */
  saveDefaults: (
    patch: (current: ProjectDefaults) => ProjectDefaults,
  ) => Promise<void>;
}

/**
 * Per-project worktree list + defaults, backed by the main-process store.
 * Keyed by the project's encoded cwd; refetches when it changes.
 */
export function useWorktrees(projectEncoded: string): UseWorktrees {
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>([]);
  const [defaults, setDefaults] = useState<ProjectDefaults>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [list, def] = await Promise.all([
      window.electronAPI.listWorktrees(projectEncoded),
      window.electronAPI.getWorktreeDefaults(projectEncoded),
    ]);
    setWorktrees(list);
    setDefaults(def);
    setLoading(false);
  }, [projectEncoded]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: CreateWorktreeInput) => {
      const rec = await window.electronAPI.createWorktree(
        projectEncoded,
        input,
      );
      await refresh();
      return rec;
    },
    [projectEncoded, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await window.electronAPI.removeWorktree(id);
      await refresh();
    },
    [refresh],
  );

  const addRepos = useCallback(
    async (id: string, input: AddReposToWorktreeInput) => {
      const rec = await window.electronAPI.addReposToWorktree(id, input);
      await refresh();
      return rec;
    },
    [refresh],
  );

  const createPr = useCallback(
    (id: string, input: CreatePrInput) =>
      window.electronAPI.createWorktreePr(id, input),
    [],
  );

  // Spreading this hook's `defaults` would revert fields written since it last
  // refreshed — creating a worktree stores its base from the main process, so a
  // Run/Build save moments later would put the old base back.
  const saveDefaults = useCallback(
    async (patch: (current: ProjectDefaults) => ProjectDefaults) => {
      const current =
        await window.electronAPI.getWorktreeDefaults(projectEncoded);
      const next = patch(current);
      await window.electronAPI.setWorktreeDefaults(projectEncoded, next);
      setDefaults(next);
    },
    [projectEncoded],
  );

  return {
    worktrees,
    loading,
    refresh,
    create,
    remove,
    addRepos,
    createPr,
    defaults,
    saveDefaults,
  };
}
