import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { basename, dirname, resolve } from "path";
import { gitSafe } from "@/main/git/git-exec";
import { encodeCwd } from "@/main/providers/claude-code/encoding";
import type { ExternalWorktreeRecord } from "@/common/shared-types";
import type { RepoLocation } from "@/main/git/git";
import type { StoredWorktree } from "./worktrees-store";

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  prunable: boolean;
  bare: boolean;
}

/** Parse `git worktree list --porcelain -z` without path quoting ambiguity. */
export function parseGitWorktrees(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let fields: string[] = [];

  const flush = () => {
    if (fields.length === 0) return;
    let path = "";
    let head = "";
    let branch: string | null = null;
    let prunable = false;
    let bare = false;

    for (const field of fields) {
      if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
      else if (field.startsWith("HEAD ")) head = field.slice("HEAD ".length);
      else if (field.startsWith("branch refs/heads/"))
        branch = field.slice("branch refs/heads/".length);
      else if (field === "bare") bare = true;
      else if (field === "prunable" || field.startsWith("prunable "))
        prunable = true;
    }

    if (path) entries.push({ path, head, branch, prunable, bare });
    fields = [];
  };

  for (const field of output.split("\0")) {
    if (field === "") flush();
    else fields.push(field);
  }
  flush();
  return entries;
}

function externalName(sourcePath: string, entry: GitWorktreeEntry): string {
  if (entry.branch) return entry.branch;
  const leaf = basename(entry.path);
  return leaf === basename(sourcePath) ? basename(dirname(entry.path)) : leaf;
}

function externalId(projectEncoded: string, path: string): string {
  const digest = createHash("sha1")
    .update(projectEncoded)
    .update("\0")
    .update(path)
    .digest("hex")
    .slice(0, 16);
  return `external:${digest}`;
}

/** realpath, memoized per sweep — the same roots recur across every project. */
function canonicalizer(): (path: string) => Promise<string> {
  const seen = new Map<string, Promise<string>>();
  return (path) => {
    let p = seen.get(path);
    if (!p) {
      p = realpath(path).catch(() => resolve(path));
      seen.set(path, p);
    }
    return p;
  };
}

interface DiscoveryInput {
  projectEncoded: string;
  /** Repo locations only — discovery never reads a live branch. */
  repos: RepoLocation[];
  /** Every Plan-managed worktree, not just this project's. */
  managed: StoredWorktree[];
  manualRoots: string[];
}

/**
 * Discover standalone checkouts belonging to a project's repos. Plan-managed
 * checkouts, the project's live repo paths, and manually-added project roots
 * are excluded so every checkout appears once in the sidebar.
 */
export async function discoverExternalWorktrees({
  projectEncoded,
  repos,
  managed,
  manualRoots,
}: DiscoveryInput): Promise<ExternalWorktreeRecord[]> {
  const canonicalPath = canonicalizer();
  const excluded = new Set<string>();
  for (const repo of repos) excluded.add(await canonicalPath(repo.path));
  for (const root of manualRoots) excluded.add(await canonicalPath(root));
  for (const worktree of managed) {
    excluded.add(await canonicalPath(worktree.rootPath));
    for (const repo of worktree.repos)
      excluded.add(await canonicalPath(repo.path));
  }

  const seenCommonDirs = new Set<string>();
  const seenPaths = new Set<string>();
  const external: ExternalWorktreeRecord[] = [];

  for (const repo of repos) {
    if (seenCommonDirs.has(repo.commonDir)) continue;
    seenCommonDirs.add(repo.commonDir);

    const result = await gitSafe(repo.path, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!result.ok) continue;

    for (const entry of parseGitWorktrees(result.stdout)) {
      const path = await canonicalPath(entry.path);
      if (
        entry.bare ||
        entry.prunable ||
        excluded.has(path) ||
        seenPaths.has(path)
      )
        continue;
      seenPaths.add(path);

      external.push({
        kind: "external",
        id: externalId(projectEncoded, path),
        projectEncoded,
        name: externalName(repo.path, entry),
        rootPath: path,
        encoded: encodeCwd(path),
        repos: [
          {
            subPath: "",
            path,
            branch: entry.branch,
            head: entry.head,
          },
        ],
        mtimeMs: 0,
      });
    }
  }

  return external;
}

/**
 * Discovery costs one `git worktree list` per source repo, and the sidebar
 * re-pulls every project's worktrees on the same watcher signal a streaming
 * chat fires -- so without this the sweep ran twice a second for as long as
 * Claude was replying.
 *
 * The result only moves when a checkout is added or removed on disk, which the
 * worktree watcher reports as `worktree-changed` (see the invalidation in
 * index.ts). The TTL is the backstop for projects whose watcher isn't running:
 * only the mounted workspace is watched, so a `git worktree add` in a
 * background project is invisible to that signal.
 */
const TTL_MS = 5_000;

interface CacheEntry {
  inputs: string;
  at: number;
  result: Promise<ExternalWorktreeRecord[]>;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached discovery for one project, or (no argument) for all of them. */
export function invalidateExternalWorktrees(encoded?: string): void {
  if (encoded === undefined) cache.clear();
  else cache.delete(encoded);
}

/** Everything the result depends on; a change here outranks the TTL. */
function inputsKey(input: DiscoveryInput): string {
  return JSON.stringify([
    input.repos.map((r) => r.path).sort(),
    input.managed
      .map((w) => [w.rootPath, ...w.repos.map((r) => r.path)].join(" "))
      .sort(),
    [...input.manualRoots].sort(),
  ]);
}

/** `discoverExternalWorktrees` behind the cache above. */
export function externalWorktrees(
  input: DiscoveryInput,
): Promise<ExternalWorktreeRecord[]> {
  const inputs = inputsKey(input);
  const key = input.projectEncoded;
  const hit = cache.get(key);
  if (hit && hit.inputs === inputs && Date.now() - hit.at < TTL_MS)
    return hit.result;

  const result = discoverExternalWorktrees(input);
  const entry: CacheEntry = { inputs, at: Date.now(), result };
  cache.set(key, entry);
  // A failed sweep must not stick as this project's answer.
  result.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return result;
}
