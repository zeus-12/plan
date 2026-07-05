import { useCallback, useEffect, useState } from "react";
import type { WorktreeRecord } from "../../shared-types";

export interface AllWorktrees {
  /** Worktrees grouped by their parent project's encoded cwd. */
  byProject: Map<string, WorktreeRecord[]>;
  refresh: () => Promise<void>;
}

/**
 * Every worktree across all projects, grouped by parent project. Feeds the
 * merged project sidebar, which nests a project's worktrees beneath it. Unlike
 * `useWorktrees` (scoped to one selected project), this spans them all.
 */
export function useAllWorktrees(): AllWorktrees {
  const [byProject, setByProject] = useState<Map<string, WorktreeRecord[]>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    const all = await window.electronAPI.listAllWorktrees();
    const map = new Map<string, WorktreeRecord[]>();
    for (const w of all) {
      const list = map.get(w.projectEncoded);
      if (list) list.push(w);
      else map.set(w.projectEncoded, [w]);
    }
    setByProject(map);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Worktrees are created/removed from within the app and can also change on
  // disk; re-pull on the same debounced watcher signal the project list uses.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.electronAPI.onWatcherEvent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  return { byProject, refresh };
}
