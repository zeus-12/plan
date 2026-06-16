import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { resolveProjectCwd } from "./claude-projects";
import type {
  SearchOptions,
  SearchResult,
  SearchFileResult,
  SearchMatch,
} from "../shared-types";

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
  return fileList(cwd);
}

/**
 * The project's file list (POSIX-relative), shared by the Files tab finder and
 * project-wide search. Prefers `git ls-files` (honours `.gitignore`), falling
 * back to a recursive walk for non-git projects.
 */
async function fileList(cwd: string): Promise<string[]> {
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

/* ── Project-wide search (the VS Code-style Search tab) ───────────── */

const SEARCH_MAX_MATCHES = 5000;
const SEARCH_MAX_PER_LINE = 500;
const SEARCH_MAX_LINE_LEN = 2000;
const SEARCH_CONCURRENCY = 16;

/** Obvious-binary extensions — skipped without ever reading the file. */
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "ogg", "m4a",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm", "node", "dylib", "so", "dll", "exe", "bin", "dat",
  "class", "jar", "o", "a", "lib", "pyc", "pdb",
  "heic", "psd", "sketch", "ai",
]);

function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the query to a JS RegExp matching VS Code's toggle semantics:
 * literal vs regex source, optional `\b` word boundaries, and case sensitivity.
 * The `g` flag lets us collect every occurrence on a line. Throws on bad regex.
 */
function buildSearchRegex(query: string, opts: SearchOptions): RegExp {
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, opts.caseSensitive ? "g" : "gi");
}

/** Every match range on one line. Guards against zero-width matches looping. */
function lineRanges(line: string, re: RegExp): { start: number; end: number }[] {
  re.lastIndex = 0;
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex = end + 1;
      if (re.lastIndex > line.length) break;
      continue;
    }
    out.push({ start, end });
    if (out.length >= SEARCH_MAX_PER_LINE) break;
  }
  return out;
}

/**
 * Search every (git-tracked, non-ignored) text file in the project for `query`.
 * Runs in Node with a JS RegExp so result counts and highlight offsets stay in
 * exact agreement with what the file viewer later renders. Skips binary and
 * oversized files; capped at {@link SEARCH_MAX_MATCHES} total matches.
 */
export async function searchProjectFiles(
  encoded: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  if (!query) return { files: [], totalMatches: 0, truncated: false };

  let re: RegExp;
  try {
    re = buildSearchRegex(query, opts);
  } catch (err) {
    return {
      files: [],
      totalMatches: 0,
      truncated: false,
      error: err instanceof Error ? err.message : "Invalid pattern",
    };
  }

  try {
    const cwd = await resolveProjectCwd(encoded);
    const paths = await fileList(cwd);

    const results: SearchFileResult[] = [];
    let totalMatches = 0;
    let truncated = false;

    // Bounded-concurrency worker pool over the path list (shared cursor).
    let cursor = 0;
    async function worker() {
      while (cursor < paths.length && !truncated) {
        const rel = paths[cursor++];
        if (BINARY_EXTS.has(extOf(rel))) continue;
        const full = join(cwd, rel);
        // Cheap size gate FIRST — never pull a huge tracked file (lockfiles,
        // bundles, datasets, media) into memory; that's what stalled/OOM'd the
        // whole search before, since every file is read regardless of the query.
        let size: number;
        try {
          const st = await stat(full);
          if (!st.isFile()) continue;
          size = st.size;
        } catch {
          continue;
        }
        if (size > MAX_READ_BYTES) continue;

        let buf: Buffer;
        try {
          buf = await readFile(full);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;

        const matches: SearchMatch[] = [];
        const lines = buf.toString("utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const ranges = lineRanges(lines[i], re);
          if (ranges.length === 0) continue;
          // Cap the preview text so a single minified/huge line can't bloat the
          // IPC payload (the panel only shows a short preview anyway; opening a
          // hit still uses the real column).
          const text =
            lines[i].length > SEARCH_MAX_LINE_LEN
              ? lines[i].slice(0, SEARCH_MAX_LINE_LEN)
              : lines[i];
          matches.push({ line: i + 1, text, ranges });
          totalMatches += ranges.length;
          if (totalMatches >= SEARCH_MAX_MATCHES) {
            truncated = true;
            break;
          }
        }
        if (matches.length > 0) results.push({ path: rel, matches });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(SEARCH_CONCURRENCY, paths.length) }, worker)
    );

    // The pool visits files out of order; restore the stable alphabetical order.
    results.sort((a, b) => a.path.localeCompare(b.path));
    return { files: results, totalMatches, truncated };
  } catch (err) {
    return {
      files: [],
      totalMatches: 0,
      truncated: false,
      error: err instanceof Error ? err.message : "Search failed",
    };
  }
}
