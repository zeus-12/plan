import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { resolveProjectCwd } from "./claude-projects";

const execFileP = promisify(execFile);

export interface FileContents {
  oldText: string;
  newText: string;
  /** True if either side appears to be a binary blob (NUL bytes within sample). */
  binary: boolean;
}

const BINARY_PROBE_BYTES = 8000;

function looksBinary(s: string): boolean {
  const sample = s.slice(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** `git show <rev>:<path>` → blob text, or "" if it doesn't exist there. */
async function gitShow(cwd: string, rev: string, path: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "show", `${rev}:${path}`],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    return "";
  }
}

async function gitDiff(
  cwd: string,
  path: string,
  cached: boolean
): Promise<string> {
  try {
    const args = ["-C", cwd, "diff", "--no-color"];
    if (cached) args.push("--cached");
    args.push("--", path);
    const { stdout } = await execFileP("git", args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function readWorking(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(join(cwd, path), "utf-8");
  } catch {
    return "";
  }
}

export async function getFileContents(
  encoded: string,
  oldPath: string | null,
  newPath: string | null,
  subPath: string = ""
): Promise<FileContents> {
  const base = await resolveProjectCwd(encoded);
  const cwd = subPath ? join(base, subPath) : base;
  const [oldText, newText] = await Promise.all([
    oldPath ? gitShow(cwd, "HEAD", oldPath) : Promise.resolve(""),
    newPath ? readWorking(cwd, newPath) : Promise.resolve(""),
  ]);
  const binary = looksBinary(oldText) || looksBinary(newText);
  return { oldText, newText, binary };
}

export interface FileView {
  oldText: string;
  newText: string;
  /** Unified diff body for just this file in this stage (for per-hunk ops). */
  diffBody: string;
  binary: boolean;
}

/**
 * Fetch one file's diff for a single stage:
 *   - "staged":   HEAD vs index  (git show HEAD:p vs :p, git diff --cached)
 *   - "unstaged": index vs work  (git show :p vs working file, git diff)
 * so the viewer shows ONLY the changes for that stage.
 */
export async function getFileView(
  encoded: string,
  path: string,
  mode: "staged" | "unstaged",
  subPath: string = ""
): Promise<FileView> {
  const base = await resolveProjectCwd(encoded);
  const cwd = subPath ? join(base, subPath) : base;

  let oldText: string;
  let newText: string;
  if (mode === "staged") {
    [oldText, newText] = await Promise.all([
      gitShow(cwd, "HEAD", path),
      gitShow(cwd, "", path), // `git show :path` → index version
    ]);
  } else {
    [oldText, newText] = await Promise.all([
      gitShow(cwd, "", path), // index version (or "" for untracked)
      readWorking(cwd, path),
    ]);
  }
  const diffBody = await gitDiff(cwd, path, mode === "staged");
  return {
    oldText,
    newText,
    diffBody,
    binary: looksBinary(oldText) || looksBinary(newText),
  };
}
