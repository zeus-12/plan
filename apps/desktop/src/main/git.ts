import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { git as run } from "./git-exec";
import { resolveProjectCwd } from "./claude-projects";
import { GIT_SCAN_DEPTH } from "./config";
import type {
  DiscoveredRepo,
  GitDiffResult,
  GitFileStatus,
  GitStatusResult,
} from "../shared-types";

async function cwdFromEncoded(
  encoded: string,
  subPath: string = "",
): Promise<string> {
  const base = await resolveProjectCwd(encoded);
  return subPath ? join(base, subPath) : base;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

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

async function inspectRepo(
  path: string,
  subPath: string,
): Promise<DiscoveredRepo | null> {
  if (!(await hasGitMarker(path))) return null;
  if (!(await isGitRepo(path))) return null;
  const commonDir = await getGitCommonDir(path);
  if (!commonDir) return null;
  return {
    path,
    subPath,
    commonDir,
    branch: await branchAt(path),
  };
}

/**
 * Find git repos at (or one level inside, per GIT_SCAN_DEPTH) a project's cwd.
 *
 * Behavior:
 *   - If the project root is a git repo → return it; do NOT descend.
 *   - Otherwise, list immediate children up to GIT_SCAN_DEPTH and return any
 *     directory that is itself a git repo. Hidden dirs are skipped.
 */
export async function discoverRepos(
  encoded: string,
): Promise<DiscoveredRepo[]> {
  const root = await resolveProjectCwd(encoded);
  const out: DiscoveredRepo[] = [];

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

async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Current branch name, or null when detached/no repo. */
export async function getBranch(
  encoded: string,
  subPath: string = "",
): Promise<string | null> {
  const cwd = await cwdFromEncoded(encoded, subPath);
  if (!(await isGitRepo(cwd))) return null;
  return branchAt(cwd);
}

export async function getStatus(
  encoded: string,
  subPath: string = "",
): Promise<GitStatusResult> {
  const cwd = await cwdFromEncoded(encoded, subPath);
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

export async function push(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await cwdFromEncoded(encoded, subPath);

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
    const r2 = await run(cwd, ["push", "--set-upstream", "origin", branch]);
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
  const r = await run(await cwdFromEncoded(encoded, subPath), [
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
  const cwd = await cwdFromEncoded(encoded, subPath);
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
  const cwd = await cwdFromEncoded(encoded, subPath);
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
  const r = await run(await cwdFromEncoded(encoded, subPath), ["add", "-A"]);
  if (r.code !== 0)
    return { ok: false, error: r.stderr || "git add -A failed" };
  return { ok: true };
}

export async function unstageAll(
  encoded: string,
  subPath: string = "",
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await cwdFromEncoded(encoded, subPath);
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
  const cwd = await cwdFromEncoded(encoded, subPath);
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
  const cwd = await cwdFromEncoded(encoded, subPath);
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
  const r = await run(await cwdFromEncoded(encoded, subPath), [
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
  const cwd = await cwdFromEncoded(encoded, subPath);
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
