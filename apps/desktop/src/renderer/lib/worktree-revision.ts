import { useSyncExternalStore } from "react";

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

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpWorktreeRevision(encoded: string) {
  revisions.set(encoded, (revisions.get(encoded) ?? 0) + 1);
  listeners.forEach((l) => l());
}

export function useWorktreeRevision(encoded: string): number {
  return useSyncExternalStore(
    subscribe,
    () => revisions.get(encoded) ?? 0,
    () => revisions.get(encoded) ?? 0,
  );
}
