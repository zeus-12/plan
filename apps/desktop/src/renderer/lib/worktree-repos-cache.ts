import type { DiscoveredRepo } from "../../shared-types";

/**
 * Per-worktree (encoded) cache of the repos resolved by `listRepos`. A worktree
 * is a synthesized project whose repos aren't known app-wide the way a real
 * project's are (`reposByProject`), so App fetches them on the switch itself.
 * Without this cache, `effectiveRepos` is empty for the first render after
 * selecting a worktree, so the keyed workspace mounts with `repos: []` and
 * immediately re-renders (re-running the git diff/status effects) once the
 * fetch resolves — a visible double-render on every worktree switch.
 *
 * Reading this synchronously during render lets a re-selected worktree mount
 * WITH its repos; the background fetch still refreshes the entry. Module scope
 * so it outlives the keyed `ProjectWorkspace` remount, mirroring session-cache.
 */
const cache = new Map<string, DiscoveredRepo[]>();

export function getCachedWorktreeRepos(encoded: string): DiscoveredRepo[] | null {
  return cache.get(encoded) ?? null;
}

export function setCachedWorktreeRepos(
  encoded: string,
  repos: DiscoveredRepo[],
): void {
  cache.set(encoded, repos);
}
