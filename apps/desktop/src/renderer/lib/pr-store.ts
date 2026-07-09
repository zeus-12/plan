import { useEffect, useSyncExternalStore } from "react";
import type { PrDetail, PrListResult } from "../../shared-types";

/**
 * Cache for the PR viewer, keyed by project `encoded`. Two layers:
 *
 *  - PR *lists* (one per repo subPath) are small, so they persist to
 *    localStorage — the sidebar repaints its last-known PRs instantly on
 *    relaunch, then revalidates.
 *  - PR *details* (description + full timeline + raw diff) can be large, so they
 *    live in memory only. Re-opening a PR within a session is instant; a cold
 *    start refetches. This keeps us clear of the localStorage quota rather than
 *    risking a silent write failure that would corrupt the whole cache blob.
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
interface DetailEntry {
  detail: PrDetail;
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
const details = new Map<string, DetailEntry>(); // `${encoded}::${subPath}#${n}` → entry
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

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

/** Fetch one PR's detail. Deduped; `force` bypasses the dedup window. */
async function fetchDetail(
  encoded: string,
  subPath: string,
  n: number,
  force: boolean,
) {
  const key = detailKey(encoded, subPath, n);
  if (inFlight.has(key)) return;
  if (!force) {
    const existing = details.get(key);
    if (existing && Date.now() - existing.fetchedAt < STALE_MS) return;
  }
  inFlight.add(key);
  emit();
  try {
    const res = await window.electronAPI.getPrDetail(encoded, subPath, n);
    if (res.ok && res.detail) {
      details.set(key, { detail: res.detail, fetchedAt: Date.now() });
    } else if (!details.has(key)) {
      // Surface the error only when there's no cached detail to fall back on;
      // a stale-but-real detail beats replacing it with an error banner.
      details.set(key, {
        detail: errorDetail(n, res.error ?? "Couldn't load this PR."),
        fetchedAt: Date.now(),
      });
    }
  } finally {
    inFlight.delete(key);
    emit();
  }
}

/** A placeholder detail carrying an error message in its title, when a PR has
 * never loaded successfully. `headSha` null so Files shows nothing. */
function errorDetail(n: number, message: string): PrDetail {
  return {
    number: n,
    title: message,
    body: "",
    state: "OPEN",
    isDraft: false,
    url: "",
    author: "",
    authorIsBot: false,
    createdAt: "",
    mergedAt: null,
    baseRefName: "",
    headRefName: "",
    additions: 0,
    deletions: 0,
    diff: "",
    timeline: [],
    commits: [],
    headSha: null,
    __error: message,
  } as PrDetail & { __error: string };
}

/**
 * Best-known title for a PR from whatever's already cached (detail first, then
 * the repo's list), for the content-pane tab label. Never triggers a fetch —
 * returns null when nothing's cached yet, so the caller falls back to `#N`.
 */
export function cachedPrTitle(
  encoded: string,
  subPath: string,
  n: number,
): string | null {
  const detail = details.get(detailKey(encoded, subPath, n));
  if (detail && !(detail.detail as PrDetail & { __error?: string }).__error) {
    return detail.detail.title;
  }
  const summary = loadLists(encoded)[subPath]?.result.prs.find(
    (p) => p.number === n,
  );
  return summary?.title ?? null;
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

export interface PrDetailState {
  detail: PrDetail | null;
  loading: boolean;
  revalidating: boolean;
  refetch: () => void;
}

/** Read + lazily fetch one PR's detail (called when a PR tab is open). */
export function usePrDetail(
  encoded: string,
  subPath: string,
  n: number,
): PrDetailState {
  useCacheVersion();
  useEffect(() => {
    void fetchDetail(encoded, subPath, n, false);
  }, [encoded, subPath, n]);

  const entry = details.get(detailKey(encoded, subPath, n)) ?? null;
  const fetching = inFlight.has(detailKey(encoded, subPath, n));
  return {
    detail: entry?.detail ?? null,
    loading: !entry && fetching,
    revalidating: !!entry && fetching,
    refetch: () => void fetchDetail(encoded, subPath, n, true),
  };
}
