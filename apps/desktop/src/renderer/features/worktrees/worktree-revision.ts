import { useSyncExternalStore } from "react";
import { createExternalValue } from "@/renderer/lib/external-value";

/**
 * Per-project "content revision" counter, bumped whenever the worktree on disk
 * changes (file edits, git stage/commit/checkout made outside the app). Content
 * panes that read file-derived data — the diff viewer and the file/image viewer
 * — include the revision in their fetch deps (and image cache-bust key) so they
 * re-pull the moment the real file changes, the way VS Code does.
 *
 * The source of truth stays the disk: a bump only triggers a re-fetch, it never
 * carries data itself. An over-eager bump (revision changed but this particular
 * file didn't) just causes a harmless redundant re-read, never a stale view.
 */

const revisions = createExternalValue<Record<string, number>>({});

export function bumpWorktreeRevision(encoded: string) {
  const cur = revisions.get();
  revisions.set({ ...cur, [encoded]: (cur[encoded] ?? 0) + 1 });
}

export function useWorktreeRevision(encoded: string): number {
  return useSyncExternalStore(
    revisions.subscribe,
    () => revisions.get()[encoded] ?? 0,
    () => revisions.get()[encoded] ?? 0,
  );
}
