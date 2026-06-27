/**
 * In-memory most-recently-used ordering for the Ctrl+Tab / Ctrl+` switchers.
 *
 * Windows Alt-Tab semantics: items are ordered by when they were last
 * activated, newest first. A single tap-release of the switcher jumps to the
 * previously used item, and tapping again returns to where you came from. The
 * order is rebuilt purely from this session's usage — it is NOT persisted, so
 * after a boot or reload items fall back to their given default order until
 * they're used.
 *
 * Scopes keep independent lists: "projects" is the single global project list;
 * content-pane tabs are scoped per worktree ("tabs:<encoded>") so each worktree
 * keeps its own order across ProjectWorkspace remounts (the store outlives them).
 */

const lists = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;
// Per-scope version counters. The global `version` bumps on ANY change, so a
// consumer subscribing to it re-renders whenever ANY scope is touched — e.g.
// switching a content tab ("tabs:<encoded>") needlessly re-rendered App and the
// project sidebar, which only care about the "projects" scope. Each consumer
// reads its own scope's version instead, re-rendering only when that scope
// actually reorders.
const scopeVersions = new Map<string, number>();

/** Move `id` to the front of its scope's order. No-op if already in front. */
export function recordUse(scope: string, id: string): void {
  const prev = lists.get(scope) ?? [];
  if (prev[0] === id) return;
  lists.set(scope, [id, ...prev.filter((x) => x !== id)]);
  version++;
  scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1);
  listeners.forEach((l) => l());
}

/** Version of a single scope — bumps only when THAT scope reorders. */
export function getMruScopeVersion(scope: string): number {
  return scopeVersions.get(scope) ?? 0;
}

/**
 * Order `items` by MRU recency (most-recent first), falling back to their given
 * order for items not yet used this session. Stable: never-used items keep
 * their default relative order, appended after the used ones.
 */
export function orderByMru<T>(
  scope: string,
  items: T[],
  idOf: (item: T) => string,
): T[] {
  const rank = new Map((lists.get(scope) ?? []).map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(idOf(item)) ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.item);
}

/**
 * The most-recently-used id among `candidates`, or null if none of them have
 * been used this session. Unlike `orderByMru`, this never falls back to a
 * default order — a null result means "no real MRU history", letting callers
 * choose their own fallback (e.g. Cmd+W dropping to the adjacent tab).
 */
export function mostRecentUsed(
  scope: string,
  candidates: Set<string>,
): string | null {
  const order = lists.get(scope) ?? [];
  return order.find((id) => candidates.has(id)) ?? null;
}

/** useSyncExternalStore plumbing so React recomputes orderings on any change. */
export function subscribeMru(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getMruVersion(): number {
  return version;
}
