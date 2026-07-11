import { useEffect, useSyncExternalStore } from "react";
import type {
  PrComment,
  PrMeta,
  PrListResult,
  PrSummary,
} from "../../shared-types";

/**
 * Cache for the PR viewer, keyed by project `encoded`. Two layers:
 *
 *  - PR *lists* (one per repo subPath) are small, so they persist to
 *    localStorage — the sidebar repaints its last-known PRs instantly on
 *    relaunch, then revalidates.
 *  - PR *details* live in memory only (they can be large — quota-safe) and are
 *    split into four independently-fetched sections: `meta` (header + commits),
 *    `conversation` (timeline), `diff` (raw patch), and `headSha` (the network
 *    ref-fetch the Files tab needs). The PR view kicks off all four in parallel
 *    and paints each the instant it lands, so the header no longer waits on the
 *    slow paginated conversation or the large diff.
 *
 * Both layers are stale-while-revalidate: a cached value paints immediately and
 * a background refetch swaps in fresh data when it lands (`revalidating` drives
 * the shimmer). Nothing optimistic — we only ever show data `gh` actually
 * returned, never a guessed or in-progress state.
 */

interface ListEntry {
  result: PrListResult;
  fetchedAt: number;
}

// How long a cached value is considered fresh enough to skip the background
// revalidation that would otherwise fire on every mount. Each `gh` call is a
// process spawn + network round-trip (and counts against GitHub's rate limit),
// so re-opening a PR tab or re-expanding a repo within this window paints the
// cached data and does NOT refetch. ⌘R (force) always bypasses this. PR data
// doesn't change second-to-second, so a minute of staleness is imperceptible
// and cuts `gh` spawns dramatically. Also absorbs React's strict-mode
// double-invoked effects (the second call sees a ~0ms-old entry and skips).
const STALE_MS = 60_000;

const lists = new Map<string, Record<string, ListEntry>>(); // encoded → subPath → entry
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

// One in-memory SWR store per detail section. Keyed by `meta::${encoded}::${subPath}#${n}`
// (namespaced so a section's key doubles as its inFlight key). `errors` holds
// the last failure only while `data` has no cached value to fall back on — a
// stale-but-real value always beats an error banner.
interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}
interface Section<T> {
  data: Map<string, CacheEntry<T>>;
  errors: Map<string, string>;
}
function makeSection<T>(): Section<T> {
  return { data: new Map(), errors: new Map() };
}
const metaSec = makeSection<PrMeta>();
const conversationSec = makeSection<PrComment[]>();
const diffSec = makeSection<string>();
const headShaSec = makeSection<string | null>();

// The hooks derive their state from several mutable maps per render, so the
// subscription snapshot is a plain version counter: any cache change bumps it,
// and useSyncExternalStore re-renders the consumers, which re-read the maps.
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function useCacheVersion() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

function listStorageKey(encoded: string): string {
  return `plan.prlists.${encoded}`;
}

function loadLists(encoded: string): Record<string, ListEntry> {
  const cached = lists.get(encoded);
  if (cached) return cached;
  let value: Record<string, ListEntry> = {};
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(listStorageKey(encoded));
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          value = parsed as Record<string, ListEntry>;
        }
      }
    } catch {
      value = {};
    }
  }
  lists.set(encoded, value);
  return value;
}

function persistLists(encoded: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      listStorageKey(encoded),
      JSON.stringify(lists.get(encoded) ?? {}),
    );
  } catch {
    // Quota / private mode — keep the in-memory value; the list just won't
    // survive a relaunch, which is a graceful degradation, not a failure.
  }
}

function listFetchKey(encoded: string, subPath: string): string {
  return `list::${encoded}::${subPath}`;
}
function detailKey(encoded: string, subPath: string, n: number): string {
  return `${encoded}::${subPath}#${n}`;
}

/** Fetch a repo's PR list. Deduped; `force` bypasses the dedup window. */
async function fetchList(encoded: string, subPath: string, force: boolean) {
  const key = listFetchKey(encoded, subPath);
  if (inFlight.has(key)) return;
  if (!force) {
    const existing = loadLists(encoded)[subPath];
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;
  }
  inFlight.add(key);
  emit(); // reflect "revalidating" while a cached value is still showing
  try {
    const result = await window.electronAPI.listPrs(encoded, subPath);
    const bucket = loadLists(encoded);
    bucket[subPath] = { result, fetchedAt: Date.now() };
    lists.set(encoded, { ...bucket });
    persistLists(encoded);
  } finally {
    inFlight.delete(key);
    emit();
  }
}

/**
 * Fetch one detail section into its store, stale-while-revalidate + deduped.
 * `run` maps the IPC result to either a value to cache or an error to surface.
 * `force` bypasses the dedup window (⌘R). The section key doubles as the
 * inFlight key, so the four sections of one PR fetch concurrently.
 */
async function fetchSection<T>(
  sec: Section<T>,
  key: string,
  force: boolean,
  run: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
) {
  if (inFlight.has(key)) return;
  if (!force) {
    const existing = sec.data.get(key);
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;
  }
  inFlight.add(key);
  emit();
  try {
    const res = await run();
    if (res.ok) {
      sec.data.set(key, { value: res.value, fetchedAt: Date.now() });
      sec.errors.delete(key);
    } else if (!sec.data.has(key)) {
      // Surface the error only when there's no cached value to fall back on;
      // a stale-but-real value beats replacing it with an error banner.
      sec.errors.set(key, res.error);
    }
  } finally {
    inFlight.delete(key);
    emit();
  }
}

function sectionKey(prefix: string, encoded: string, subPath: string, n: number) {
  return `${prefix}::${detailKey(encoded, subPath, n)}`;
}

function fetchMeta(encoded: string, subPath: string, n: number, force: boolean) {
  return fetchSection(metaSec, sectionKey("meta", encoded, subPath, n), force, async () => {
    const res = await window.electronAPI.getPrMeta(encoded, subPath, n);
    return res.ok && res.meta
      ? { ok: true, value: res.meta }
      : { ok: false, error: res.error ?? "Couldn't load this PR." };
  });
}

function fetchConversation(encoded: string, subPath: string, n: number, force: boolean) {
  return fetchSection(
    conversationSec,
    sectionKey("conv", encoded, subPath, n),
    force,
    async () => {
      const res = await window.electronAPI.getPrConversation(encoded, subPath, n);
      return res.ok && res.timeline
        ? { ok: true, value: res.timeline }
        : { ok: false, error: res.error ?? "Couldn't load the conversation." };
    },
  );
}

function fetchDiff(encoded: string, subPath: string, n: number, force: boolean) {
  return fetchSection(diffSec, sectionKey("diff", encoded, subPath, n), force, async () => {
    const res = await window.electronAPI.getPrDiff(encoded, subPath, n);
    return res.ok && res.diff != null
      ? { ok: true, value: res.diff }
      : { ok: false, error: res.error ?? "Couldn't load the changes." };
  });
}

function fetchHeadSha(encoded: string, subPath: string, n: number, force: boolean) {
  return fetchSection(
    headShaSec,
    sectionKey("head", encoded, subPath, n),
    force,
    async () => {
      const res = await window.electronAPI.getPrHeadSha(encoded, subPath, n);
      // headSha === null is a real value (offline / no access), not an error.
      return res.ok
        ? { ok: true, value: res.headSha ?? null }
        : { ok: false, error: res.error ?? "" };
    },
  );
}

/** Force-refetch every section of a PR (⌘R / the refresh button). */
export function refetchPr(encoded: string, subPath: string, n: number) {
  void fetchMeta(encoded, subPath, n, true);
  void fetchConversation(encoded, subPath, n, true);
  void fetchDiff(encoded, subPath, n, true);
  void fetchHeadSha(encoded, subPath, n, true);
}

/**
 * Best-known title for a PR from whatever's already cached (loaded meta first,
 * then the repo's list), for the content-pane tab label. Never triggers a
 * fetch — returns null when nothing's cached, so the caller falls back to `#N`.
 */
export function cachedPrTitle(
  encoded: string,
  subPath: string,
  n: number,
): string | null {
  const meta = metaSec.data.get(sectionKey("meta", encoded, subPath, n));
  if (meta) return meta.value.title;
  return cachedPrSummary(encoded, subPath, n)?.title ?? null;
}

/**
 * The PR's list summary if the repo's list is already cached — lets the PR view
 * paint its header (title, state, branches) the instant the tab opens, before
 * `gh pr view` returns. Never triggers a fetch. Real data `gh pr list` returned,
 * not a guess.
 */
export function cachedPrSummary(
  encoded: string,
  subPath: string,
  n: number,
): PrSummary | null {
  return (
    loadLists(encoded)[subPath]?.result.prs.find((p) => p.number === n) ?? null
  );
}

export interface PrListState {
  result: PrListResult | null;
  /** No cached list yet and a fetch is running. */
  loading: boolean;
  /** A cached list is showing while a fresh fetch runs. */
  revalidating: boolean;
  /** Force a fresh fetch (Cmd+R), keeping the cached list visible meanwhile. */
  refetch: () => void;
}

/** Read + lazily fetch a repo's PR list. `enabled` gates the fetch (only when
 * the repo section is expanded), so we never fan out across every repo. */
export function usePrList(
  encoded: string,
  subPath: string,
  enabled: boolean,
): PrListState {
  useCacheVersion();
  useEffect(() => {
    if (enabled) void fetchList(encoded, subPath, false);
  }, [encoded, subPath, enabled]);

  const entry = loadLists(encoded)[subPath] ?? null;
  const fetching = inFlight.has(listFetchKey(encoded, subPath));
  return {
    result: entry?.result ?? null,
    loading: !entry && fetching,
    revalidating: !!entry && fetching,
    refetch: () => void fetchList(encoded, subPath, true),
  };
}

/** One detail section's view state. `value` is the cached data (stale-while-
 * revalidate); `error` is set only when there's no value to show. */
export interface SectionState<T> {
  value: T | null;
  error: string | null;
  /** No cached value yet and a fetch is running (show a skeleton). */
  loading: boolean;
  /** A cached value is showing while a fresh fetch runs (show a shimmer). */
  revalidating: boolean;
}

function readSection<T>(sec: Section<T>, key: string): SectionState<T> {
  const entry = sec.data.get(key) ?? null;
  const fetching = inFlight.has(key);
  return {
    value: entry?.value ?? null,
    error: entry ? null : (sec.errors.get(key) ?? null),
    loading: !entry && fetching,
    revalidating: !!entry && fetching,
  };
}

/** Read + lazily fetch the PR shell (header + description + commits). */
export function usePrMeta(
  encoded: string,
  subPath: string,
  n: number,
): SectionState<PrMeta> {
  useCacheVersion();
  useEffect(() => {
    void fetchMeta(encoded, subPath, n, false);
  }, [encoded, subPath, n]);
  return readSection(metaSec, sectionKey("meta", encoded, subPath, n));
}

/** Read + lazily fetch the PR conversation timeline. */
export function usePrConversation(
  encoded: string,
  subPath: string,
  n: number,
): SectionState<PrComment[]> {
  useCacheVersion();
  useEffect(() => {
    void fetchConversation(encoded, subPath, n, false);
  }, [encoded, subPath, n]);
  return readSection(conversationSec, sectionKey("conv", encoded, subPath, n));
}

/** Read + lazily fetch the PR's raw unified diff. */
export function usePrDiff(
  encoded: string,
  subPath: string,
  n: number,
): SectionState<string> {
  useCacheVersion();
  useEffect(() => {
    void fetchDiff(encoded, subPath, n, false);
  }, [encoded, subPath, n]);
  return readSection(diffSec, sectionKey("diff", encoded, subPath, n));
}

/** Read + lazily fetch the PR head SHA (the network ref-fetch the Files tab
 * needs). `value` null with no error = fetched but unavailable (offline). */
export function usePrHeadSha(
  encoded: string,
  subPath: string,
  n: number,
): SectionState<string | null> {
  useCacheVersion();
  useEffect(() => {
    void fetchHeadSha(encoded, subPath, n, false);
  }, [encoded, subPath, n]);
  return readSection(headShaSec, sectionKey("head", encoded, subPath, n));
}
