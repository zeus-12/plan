import { execFile } from "child_process";
import { promisify } from "util";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { resolveProjectCwd } from "./claude-projects";
import { GIT_SCAN_DEPTH } from "./config";

const execFileP = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git with the given args in cwd. Never throws — non-zero exit is captured. */
async function run(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  try {
    const proc = execFile("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
    });
    if (stdin) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        let out = "";
        let err = "";
        proc.stdout?.on("data", (c) => (out += c.toString()));
        proc.stderr?.on("data", (c) => (err += c.toString()));
        proc.on("error", reject);
        proc.on("close", () => resolve({ stdout: out, stderr: err }));
      }
    );
    return { stdout, stderr, code: proc.exitCode ?? 0 };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    };
  }
}

export interface GitFileStatus {
  path: string;
  /** Whether the file has changes staged. */
  staged: boolean;
  /** Whether the file has unstaged changes in the working tree. */
  unstaged: boolean;
  /** XY codes from `git status --porcelain` (e.g. " M", "M ", "MM"). */
  code: string;
}

export interface GitStatusResult {
  available: boolean;
  branch: string | null;
  files: GitFileStatus[];
}

async function cwdFromEncoded(
  encoded: string,
  subPath: string = ""
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

export interface DiscoveredRepo {
  /** Absolute path to the repo root. */
  path: string;
  /** Path relative to the project's cwd. "" when the project itself is the repo. */
  subPath: string;
  /** Canonical git dir — equal across worktrees of the same source repo. */
  commonDir: string;
  branch: string | null;
}

async function inspectRepo(
  path: string,
  subPath: string
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
export async function discoverRepos(encoded: string): Promise<DiscoveredRepo[]> {
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
  subPath: string = ""
): Promise<string | null> {
  const cwd = await cwdFromEncoded(encoded, subPath);
  if (!(await isGitRepo(cwd))) return null;
  return branchAt(cwd);
}

export async function getStatus(
  encoded: string,
  subPath: string = ""
): Promise<GitStatusResult> {
  const cwd = await cwdFromEncoded(encoded, subPath);
  if (!(await isGitRepo(cwd))) {
    return { available: false, branch: null, files: [] };
  }
  const [branchRes, statusRes] = await Promise.all([
    run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    // --untracked-files=all lists each untracked file individually instead of
    // collapsing a fully-untracked directory into a single "dir/" entry.
    run(cwd, ["status", "--porcelain=v1", "--no-renames", "--untracked-files=all"]),
  ]);
  const branchRaw = branchRes.stdout.trim();
  const branch = !branchRaw || branchRaw === "HEAD" ? null : branchRaw;

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

  return { available: true, branch, files };
}

export async function stageFile(
  encoded: string,
  path: string,
  subPath: string = ""
): Promise<{ ok: boolean; error?: string }> {
  const r = await run(await cwdFromEncoded(encoded, subPath), ["add", "--", path]);
  if (r.code !== 0) return { ok: false, error: r.stderr || "git add failed" };
  return { ok: true };
}

export async function unstageFile(
  encoded: string,
  path: string,
  subPath: string = ""
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
  subPath: string = ""
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
  subPath: string = ""
): Promise<{ ok: boolean; error?: string }> {
  const r = await run(await cwdFromEncoded(encoded, subPath), ["add", "-A"]);
  if (r.code !== 0) return { ok: false, error: r.stderr || "git add -A failed" };
  return { ok: true };
}

export async function unstageAll(
  encoded: string,
  subPath: string = ""
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await cwdFromEncoded(encoded, subPath);
  const r = await run(cwd, ["restore", "--staged", "."]);
  if (r.code !== 0) {
    const r2 = await run(cwd, ["reset", "HEAD"]);
    if (r2.code !== 0) return { ok: false, error: r2.stderr || r.stderr };
  }
  return { ok: true };
}

export async function commit(
  encoded: string,
  message: string,
  subPath: string = ""
): Promise<{ ok: boolean; error?: string }> {
  if (!message.trim()) return { ok: false, error: "Commit message is required" };
  const r = await run(await cwdFromEncoded(encoded, subPath), ["commit", "-m", message]);
  if (r.code !== 0) return { ok: false, error: r.stderr || "git commit failed" };
  return { ok: true };
}

export interface ApplyHunkOptions {
  /** "stage" → --cached; "discard" → --reverse (against the working tree). */
  mode: "stage" | "unstage" | "discard";
}

/** Apply (or reverse) a patch via stdin. Returns true on success. */
export async function applyPatch(
  encoded: string,
  patch: string,
  opts: ApplyHunkOptions,
  subPath: string = ""
): Promise<{ ok: boolean; error?: string }> {
  const cwd = await cwdFromEncoded(encoded, subPath);
  const args: string[] = ["apply", "--whitespace=nowarn", "--unidiff-zero"];
  if (opts.mode === "stage") args.push("--cached");
  else if (opts.mode === "unstage") {
    args.push("--cached", "--reverse");
  } else if (opts.mode === "discard") {
    args.push("--reverse");
  }
  args.push("-");
  const r = await run(cwd, args, patch);
  if (r.code !== 0) {
    // Retry without --unidiff-zero in case the patch already has context.
    const args2 = args.filter((a) => a !== "--unidiff-zero");
    const r2 = await run(cwd, args2, patch);
    if (r2.code !== 0) {
      return { ok: false, error: r2.stderr || r.stderr || "git apply failed" };
    }
  }
  return { ok: true };
}
