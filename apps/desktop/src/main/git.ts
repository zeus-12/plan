import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { git as run } from "./git-exec";
import { pathExists } from "./fs-util";
import { resolveProjectCwd } from "./providers/claude-code/projects";
import { resolveWorkspaceCwd } from "./workspace";
import { GIT_SCAN_DEPTH } from "./config";
import type {
  DiscoveredRepo,
  GitDiffResult,
  GitFileStatus,
  GitStatusResult,
  PendingCommit,
  PushPreview,
} from "../shared-types";

/** Cheap pre-check: is there a `.git` file or directory at this path? */
async function hasGitMarker(cwd: string): Promise<boolean> {
  return pathExists(join(cwd, ".git"));
}

/**
 * Canonical git directory for a worktree. All worktrees of the same source
 * repo return the same path here, which is what we use for sidebar grouping.
 */
async function getGitCommonDir(cwd: string): Promise<string | null> {
  const r = await run(cwd, ["rev-parse", "--git-common-dir"]);
  if (r.code !== 0) return null;
  let dir = r.stdout.trim();
  if (!dir) return null;
  // git returns relative paths sometimes — anchor against cwd.
  if (!dir.startsWith("/")) dir = resolve(cwd, dir);
  return dir;
}

async function branchAt(cwd: string): Promise<string | null> {
  const r = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return !name || name === "HEAD" ? null : name;
}

/** Where a repo lives — a DiscoveredRepo minus the volatile `branch`. */
export type RepoLocation = Omit<DiscoveredRepo, "branch">;

async function inspectRepo(
  path: string,
  subPath: string,
): Promise<RepoLocation | null> {
  if (!(await hasGitMarker(path))) return null;
  if (!(await isGitRepo(path))) return null;
  const commonDir = await getGitCommonDir(path);
  if (!commonDir) return null;
  return { path, subPath, commonDir };
}

/**
 * Find git repos at (or one level inside, per GIT_SCAN_DEPTH) a project's cwd.
 *
 * Behavior:
 *   - If the project root is a git repo → return it; do NOT descend.
 *   - Otherwise, list immediate children up to GIT_SCAN_DEPTH and return any
 *     directory that is itself a git repo. Hidden dirs are skipped.
 */
async function discoverLayout(encoded: string): Promise<RepoLocation[]> {
  const root = await resolveProjectCwd(encoded);
  const out: RepoLocation[] = [];

  const rootRepo = await inspectRepo(root, "");
  if (rootRepo) {
    out.push(rootRepo);
    return out;
  }

  if (GIT_SCAN_DEPTH <= 0) return out;

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sub = await inspectRepo(join(root, entry.name), entry.name);
    if (sub) out.push(sub);
  }

  // Sort by sub-path for stable display.
  out.sort((a, b) => a.subPath.localeCompare(b.subPath));
  return out;
}

// Where a project's repos live is stable for a session except when the tree
// itself changes — and every observable change (file edits around a `git
// init`, worktree create/add/remove) either flows through the worktree watcher
// (which calls invalidateRepoLayout on every worktree-changed, at most once
// per debounce window) or through worktrees.ts's explicit invalidation. The
// PR view alone was re-running the 3-spawn discovery ~4× per opened file
// without this. Promise-cached so concurrent callers share one discovery.
const layoutCache = new Map<string, Promise<RepoLocation[]>>();

export function invalidateRepoLayout(encoded: string): void {
  layoutCache.delete(encoded);
}

export function repoLayout(encoded: string): Promise<RepoLocation[]> {
  let p = layoutCache.get(encoded);
  if (!p) {
    p = discoverLayout(encoded);
    layoutCache.set(encoded, p);
    // A rejected discovery must not stick as this project's answer.
    p.catch(() => {
      if (layoutCache.get(encoded) === p) layoutCache.delete(encoded);
    });
  }
  return p;
}

/** Layout plus each repo's current branch (branch is re-read every call —
 *  checkouts must show up — but the discovery spawns are cached). */
export async function discoverRepos(
  encoded: string,
): Promise<DiscoveredRepo[]> {
  const layout = await repoLayout(encoded);
  return Promise.all(
    layout.map(async (r) => ({ ...r, branch: await branchAt(r.path) })),
  );
}

/**
 * Remote branch names per repo (subPath → sorted names), for base-branch
 * autocomplete in the worktree modals. Reads local remote-tracking refs
 * (`refs/remotes/*`), strips the `<remote>/` prefix, dedupes across remotes,
 * and drops the symbolic `HEAD`. These are hints only: the create/add flow
 * still fetches whatever base the user commits to, so a branch that isn't
 * listed here (e.g. not fetched yet) is perfectly fine to type by hand.
 */
export async function remoteBranchesByRepo(
  encoded: string,
): Promise<Record<string, string[]>> {
  const layout = await repoLayout(encoded);
  const entries = await Promise.all(
    layout.map(
      async (r) => [r.subPath, await remoteBranchesAt(r.path)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function remoteBranchesAt(cwd: string): Promise<string[]> {
  const r = await run(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes",
  ]);
  if (r.code !== 0) return [];
  const names = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const ref = line.trim();
    if (!ref) continue;
    // "<remote>/<branch>" → "<branch>"; skip the symbolic "origin/HEAD".
    const slash = ref.indexOf("/");
    if (slash < 0) continue;
    const name = ref.slice(slash + 1);
    if (!name || name === "HEAD") continue;
    names.add(name);
  }
  return [...names].sort();
}

/** Absolute cwd for the repo at `subPath` within a project (first repo when
 *  `subPath` doesn't match), or null with no repos. Cached — zero spawns in
 *  steady state, unlike discoverRepos which re-reads branches. */
export async function repoPathFor(
  encoded: string,
  subPath: string,
): Promise<string | null> {
  const layout = await repoLayout(encoded);
  const repo = layout.find((r) => r.subPath === subPath) ?? layout[0];
  return repo?.path ?? null;
}

// Positive-only cache: a path that is a work tree stays one for the app's
// lifetime (negatives are NOT cached, so a later `git init` is still noticed).
// Saves one spawn from every status/branch/diff call.
const knownWorkTrees = new Set<string>();

async function isGitRepo(cwd: string): Promise<boolean> {
  if (knownWorkTrees.has(cwd)) return true;
  const r = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const yes = r.code === 0 && r.stdout.trim() === "true";
  if (yes) knownWorkTrees.add(cwd);
  return yes;
}

/** Current branch name, or null when detached/no repo. */
export async function getBranch(
  encoded: string,
  subPath: string = "",
): Promise<string | null> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  if (!(await isGitRepo(cwd))) return null;
  return branchAt(cwd);
}

export async function getStatus(
  encoded: string,
  subPath: string = "",
): Promise<GitStatusResult> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  if (!(await isGitRepo(cwd))) {
    return {
      available: false,
      branch: null,
      files: [],
      ahead: 0,
      hasUpstream: false,
    };
  }
  const [branchRes, statusRes] = await Promise.all([
    run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // --untracked-files=all lists each untracked file individually instead of
    // collapsing a fully-untracked directory into a single "dir/" entry.
    run(cwd, [
      "status",
      "--porcelain=v1",
      "--no-renames",
      "--untracked-files=all",
    ]),
  ]);
  const branchRaw = branchRes.stdout.trim();
  const branch = !branchRaw || branchRaw === "HEAD" ? null : branchRaw;

  // Commits ahead of the upstream (for the push button). No upstream → 0.
  let ahead = 0;
  let hasUpstream = false;
  const up = await run(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  if (up.code === 0) {
    hasUpstream = true;
    ahead = parseInt(up.stdout.trim() || "0", 10) || 0;
  }

  const files: GitFileStatus[] = [];
  for (const line of statusRes.stdout.split("\n")) {
    if (!line || line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " ";
    files.push({ path, staged, unstaged, code: `${x}${y}` });
  }

  return { available: true, branch, files, ahead, hasUpstream };
}

/** Remote the publish path below pushes a branch to on its first push. */
const PUBLISH_REMOTE = "origin";
const PUSH_PREVIEW_LIMIT = 50;

/**
 * What `push` below would send, read before it runs so the push dialog states
 * facts instead of guesses. With an upstream that's `@{upstream}..HEAD`; before
 * the first push there's no upstream to diff against, so it's every commit no
 * remote-tracking ref already holds.
 */
export async function pushPreview(
  encoded: string,
  subPath: string = "",
): Promise<PushPreview> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const empty: PushPreview = {
    available: false,
    branch: null,
    upstream: null,
    publishTarget: null,
    commits: [],
    truncated: false,
  };
  if (!(await isGitRepo(cwd))) return empty;

  const branch = await branchAt(cwd);
  const [up, remotes] = await Promise.all([
    run(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    run(cwd, ["remote"]),
  ]);
  const upstream = up.code === 0 ? up.stdout.trim() || null : null;
  const hasPublishRemote = remotes.stdout
    .split("\n")
    .map((r) => r.trim())
    .includes(PUBLISH_REMOTE);

  const range = upstream
    ? ["@{upstream}..HEAD"]
    : ["HEAD", "--not", "--remotes"];
  const log = await run(cwd, [
    "log",
    `--max-count=${PUSH_PREVIEW_LIMIT + 1}`,
    "--format=%h%x00%s",
    ...range,
  ]);
  const lines =
    log.code === 0 ? log.stdout.split("\n").filter((l) => l.length > 0) : [];
  const commits: PendingCommit[] = lines
    .slice(0, PUSH_PREVIEW_LIMIT)
    .map((line) => {
      const sep = line.indexOf("\0");
      return { sha: line.slice(0, sep), subject: line.slice(sep + 1) };
    });

  return {
    available: true,
    branch,
    upstream,
    publishTarget:
      upstream || !branch || !hasPublishRemote
        ? null
        : `${PUBLISH_REMOTE}/${branch}`,
    commits,
    truncated: lines.length > PUSH_PREVIEW_LIMIT,
  };
}

export async function push(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);

  // Mirror VS Code's "sync": pull before pushing so remote commits are merged
  // in and the push isn't rejected as non-fast-forward. Skip when the branch
  // has no upstream yet — there's nothing to pull, and the publish path below
  // handles first push.
  const hasUpstream =
    (await run(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])).code === 0;
  if (hasUpstream) {
    // `git pull` aborts when no reconcile strategy is configured. Default this
    // repo to merge — but only when the user hasn't already chosen one in any
    // scope, so an explicit preference (e.g. rebase) is respected.
    const cfg = await run(cwd, ["config", "pull.rebase"]);
    if (cfg.code !== 0 || !cfg.stdout.trim()) {
      await run(cwd, ["config", "pull.rebase", "false"]);
    }
    const pull = await run(cwd, ["pull"]);
    if (pull.code !== 0) {
      return { ok: false, error: pull.stderr || "git pull failed" };
    }
  }

  const r = await run(cwd, ["push"]);
  if (r.code === 0) return { ok: true };
  // No upstream configured → set it on first push.
  if (/upstream|set[- ]upstream/i.test(r.stderr)) {
    const branch = await branchAt(cwd);
    if (!branch) return { ok: false, error: r.stderr };
    const r2 = await run(cwd, [
      "push",
      "--set-upstream",
      PUBLISH_REMOTE,
      branch,
    ]);
    if (r2.code !== 0)
      return { ok: false, error: r2.stderr || "git push failed" };
    return { ok: true };
  }
  return { ok: false, error: r.stderr || "git push failed" };
}

export async function stageFile(
  encoded: string,
  path: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const r = await run(await resolveWorkspaceCwd(encoded, subPath), [
    "add",
    "--",
    path,
  ]);
  if (r.code !== 0) return { ok: false, error: r.stderr || "git add failed" };
  return { ok: true };
}

export async function unstageFile(
  encoded: string,
  path: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const r = await run(cwd, ["restore", "--staged", "--", path]);
  if (r.code !== 0) {
    const r2 = await run(cwd, ["reset", "HEAD", "--", path]);
    if (r2.code !== 0) return { ok: false, error: r2.stderr || r.stderr };
  }
  return { ok: true };
}

export async function discardFile(
  encoded: string,
  path: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const r = await run(cwd, ["restore", "--worktree", "--", path]);
  if (r.code !== 0) {
    const c = await run(cwd, ["clean", "-f", "--", path]);
    if (c.code !== 0) {
      return { ok: false, error: r.stderr || c.stderr };
    }
  }
  return { ok: true };
}

export async function stageAll(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const r = await run(await resolveWorkspaceCwd(encoded, subPath), [
    "add",
    "-A",
  ]);
  if (r.code !== 0)
    return { ok: false, error: r.stderr || "git add -A failed" };
  return { ok: true };
}

export async function unstageAll(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const r = await run(cwd, ["restore", "--staged", "."]);
  if (r.code !== 0) {
    const r2 = await run(cwd, ["reset", "HEAD"]);
    if (r2.code !== 0) return { ok: false, error: r2.stderr || r.stderr };
  }
  return { ok: true };
}

/**
 * Discard every unstaged change in the working tree: restore tracked files to
 * the index version and remove untracked files/dirs. Staged changes are left
 * intact. Destructive — callers should confirm.
 */
export async function discardAll(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const restore = await run(cwd, ["restore", "--worktree", "."]);
  const clean = await run(cwd, ["clean", "-fd"]);
  if (restore.code !== 0 && clean.code !== 0) {
    return {
      ok: false,
      error: restore.stderr || clean.stderr || "discard failed",
    };
  }
  return { ok: true };
}

/**
 * Stash all local changes (staged, unstaged, and untracked), reverting the
 * working tree to HEAD. Recoverable via `git stash pop`.
 */
export async function stashAll(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const r = await run(cwd, ["stash", "push", "--include-untracked"]);
  if (r.code !== 0) return { ok: false, error: r.stderr || "git stash failed" };
  if (/No local changes to save/i.test(r.stdout)) {
    return { ok: false, error: "No local changes to stash" };
  }
  return { ok: true };
}

export async function commit(
  encoded: string,
  message: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  if (!message.trim())
    return { ok: false, error: "Commit message is required" };
  const r = await run(await resolveWorkspaceCwd(encoded, subPath), [
    "commit",
    "-m",
    message,
  ]);
  if (r.code !== 0)
    return { ok: false, error: r.stderr || "git commit failed" };
  return { ok: true };
}

export interface ApplyHunkOptions {
  /**
   * "stage" → --cached; "unstage" → --cached --reverse;
   * "discard" → --reverse (working tree); "apply" → forward apply (working
   * tree, used to undo a discard).
   */
  mode: "stage" | "unstage" | "discard" | "apply";
}

/** Apply (or reverse) a patch via stdin. Returns true on success. */
export async function applyPatch(
  encoded: string,
  patch: string,
  opts: ApplyHunkOptions,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const args: string[] = ["apply", "--whitespace=nowarn", "--unidiff-zero"];
  if (opts.mode === "stage") args.push("--cached");
  else if (opts.mode === "unstage") {
    args.push("--cached", "--reverse");
  } else if (opts.mode === "discard") {
    args.push("--reverse");
  }
  // "apply" → no extra flags (forward apply to the working tree).
  args.push("-");
  const r = await run(cwd, args, { stdin: patch });
  if (r.code !== 0) {
    // Retry without --unidiff-zero in case the patch already has context.
    const args2 = args.filter((a) => a !== "--unidiff-zero");
    const r2 = await run(cwd, args2, { stdin: patch });
    if (r2.code !== 0) {
      return { ok: false, error: r2.stderr || r.stderr || "git apply failed" };
    }
  }
  return { ok: true };
}

/**
 * Returns the working-tree diff against HEAD for the given cwd. Includes both
 * staged and unstaged changes. Returns `available: false` if the path isn't a
 * git repo or git isn't installed.
 */
export async function getWorkingTreeDiff(cwd: string): Promise<GitDiffResult> {
  const check = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (check.code !== 0) return { available: false, diff: "" };

  const r = await run(cwd, ["diff", "HEAD", "--no-color"]);
  if (r.code !== 0) {
    return {
      available: true,
      diff: "",
      error: r.stderr.trim() || "git diff failed",
    };
  }
  return { available: true, diff: r.stdout };
}
