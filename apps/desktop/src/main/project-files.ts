import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";
import { join, relative, sep } from "path";
import { resolveProjectCwd } from "./claude-projects";

const execFileP = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Directories never worth indexing — heavy, generated, or VCS internals. */
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".svelte-kit",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  ".idea",
  "vendor",
  ".yarn",
  "Pods",
  "DerivedData",
]);

const MAX_FILES = 20000;
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Flat list of project files (POSIX-relative paths), for the Files tab and the
 * ⌘P finder. Uses `git ls-files` (tracked + untracked-not-ignored) when the
 * project is a git repo — fast and honours `.gitignore`, and rides the same
 * proven git path the Diffs tab uses. Falls back to a recursive walk (skipping
 * heavy dirs) for non-git projects.
 */
export async function listProjectFiles(encoded: string): Promise<string[]> {
  const cwd = await resolveProjectCwd(encoded);

  try {
    const { stdout } = await execFileP(
      "git",
      [
        "-C",
        cwd,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { maxBuffer: MAX_BUFFER }
    );
    const files = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) {
      files.sort((a, b) => a.localeCompare(b));
      return files.slice(0, MAX_FILES);
    }
  } catch {
    // Not a git repo (or git unavailable) — fall through to a plain walk.
  }

  return walkFiles(cwd);
}

async function walkFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(cwd, join(dir, e.name)).split(sep).join("/"));
      }
    }
  }
  await walk(cwd);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export interface ProjectFile {
  text: string;
  truncated: boolean;
  binary: boolean;
}

/** Read one project file for the viewer. Guards against path traversal. */
export async function readProjectFile(
  encoded: string,
  relPath: string
): Promise<ProjectFile | null> {
  const cwd = await resolveProjectCwd(encoded);
  const full = join(cwd, relPath);
  // The resolved path must stay within the project root.
  const rel = relative(cwd, full);
  if (rel.startsWith("..") || rel === "") return null;
  try {
    const buf = await readFile(full);
    const binary = isBinary(buf);
    const truncated = buf.length > MAX_READ_BYTES;
    return {
      text: binary ? "" : buf.subarray(0, MAX_READ_BYTES).toString("utf-8"),
      truncated,
      binary,
    };
  } catch {
    return null;
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Absolute filesystem path for a project-relative file, or null if it escapes
 * the project root. Used to build a `file://` URL for image previews — no bytes
 * are read into JS (same approach as transcript images).
 */
export async function resolveProjectFilePath(
  encoded: string,
  relPath: string
): Promise<string | null> {
  const cwd = await resolveProjectCwd(encoded);
  const full = join(cwd, relPath);
  const rel = relative(cwd, full);
  if (rel.startsWith("..") || rel === "") return null;
  return full;
}
