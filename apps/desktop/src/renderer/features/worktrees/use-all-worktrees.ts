import { useCallback, useEffect, useState } from "react";
import { sameJson } from "@plan/shared/lib/utils";
import type { WorktreeRecord } from "@/common/shared-types";

export interface AllWorktrees {
  /** Worktrees grouped by their parent project's encoded cwd. */
  byProject: Map<string, WorktreeRecord[]>;
  /** True once the first fetch has landed — before that, empty ≠ "none". */
  loaded: boolean;
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
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const all = await window.electronAPI.listAllWorktrees();
    const map = new Map<string, WorktreeRecord[]>();
    for (const w of all) {
      const list = map.get(w.projectEncoded);
      if (list) list.push(w);
      else map.set(w.projectEncoded, [w]);
    }
    // Watcher ticks mostly return identical content — keep the old Map identity
    // so the sidebar doesn't re-render through every streaming tick.
    setByProject((prev) =>
      sameJson([...prev.entries()], [...map.entries()]) ? prev : map,
    );
    setLoaded(true);
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

  return { byProject, loaded, refresh };
}
