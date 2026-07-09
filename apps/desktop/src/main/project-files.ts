import { createReadStream } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { StringDecoder } from "string_decoder";
import { join, relative } from "path";
import { resolveProjectCwd } from "./claude-projects";
import { IGNORED_DIRS, IGNORED_FILES } from "./ignored-dirs";
import type {
  ProjectFile,
  SearchOptions,
  SearchResult,
  SearchFileResult,
  SearchMatch,
} from "../shared-types";

const MAX_FILES = 20000;
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB

// Directory names we never descend into during the recursive walk. See
// {@link ./ignored-dirs.ts}; shared with the worktree watcher.
const IGNORE_DIRS = IGNORED_DIRS;

/**
 * Flat list of project files (POSIX-relative paths), for the Files tab and the
 * ⌘P finder. A single recursive filesystem walk that prunes the directories in
 * {@link IGNORE_DIRS} as it descends. Reads from disk directly — no `git`
 * subprocess, no `.gitignore` parsing — so it always matches what's on disk and
 * behaves identically whether or not the project is a git repo.
 */
export async function listProjectFiles(encoded: string): Promise<string[]> {
  const cwd = await resolveProjectCwd(encoded);
  return fileList(cwd);
}

/**
 * The project's file list (POSIX-relative), shared by the Files tab finder and
 * project-wide search. Walks the filesystem, skipping {@link IGNORE_DIRS}.
 */
async function fileList(cwd: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, relDir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (IGNORED_FILES.has(e.name)) continue;
        out.push(childRel);
      }
    }
  }

  await walk(cwd, "");
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, MAX_FILES);
}

/** Read one project file for the viewer. Guards against path traversal. */
export async function readProjectFile(
  encoded: string,
  relPath: string,
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
  relPath: string,
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
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tif",
  "tiff",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "wasm",
  "node",
  "dylib",
  "so",
  "dll",
  "exe",
  "bin",
  "dat",
  "class",
  "jar",
  "o",
  "a",
  "lib",
  "pyc",
  "pdb",
  "heic",
  "psd",
  "sketch",
  "ai",
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
function lineRanges(
  line: string,
  re: RegExp,
): { start: number; end: number }[] {
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
 * Stream a file's lines without ever holding the whole file in memory, so file
 * size never gates whether a match is found. Reads fixed-size chunks, decodes
 * UTF-8 safely across chunk boundaries, and splits on "\n" (keeping any "\r" so
 * offsets match the file viewer). Bails before yielding anything if the first
 * chunk looks binary (contains a NUL byte), mirroring {@link isBinary}.
 */
async function* streamLines(full: string): AsyncGenerator<string> {
  const stream = createReadStream(full, { highWaterMark: 1 << 16 });
  const decoder = new StringDecoder("utf-8");
  let rem = "";
  let first = true;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (first) {
        first = false;
        const n = Math.min(chunk.length, 8000);
        for (let i = 0; i < n; i++) {
          if (chunk[i] === 0) return; // binary — skip the whole file
        }
      }
      rem += decoder.write(chunk);
      let nl = rem.indexOf("\n");
      while (nl !== -1) {
        yield rem.slice(0, nl);
        rem = rem.slice(nl + 1);
        nl = rem.indexOf("\n");
      }
    }
  } finally {
    stream.destroy();
  }
  rem += decoder.end();
  if (rem.length > 0) yield rem;
}

/**
 * Search every (git-tracked, non-ignored) text file in the project for `query`.
 * Runs in Node with a JS RegExp so result counts and highlight offsets stay in
 * exact agreement with what the file viewer later renders. Skips binary files;
 * file size is never a gate (files stream line-by-line). Capped only at
 * {@link SEARCH_MAX_MATCHES} total matches.
 */
export async function searchProjectFiles(
  encoded: string,
  query: string,
  opts: SearchOptions,
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
        // Confirm it's a regular file (skip dirs/sockets). No size gate — files
        // stream line-by-line below, so memory stays bounded by the longest
        // line, not the file size. A big file is searched like any other and
        // shows up purely on whether it matches, never on how large it is.
        try {
          const st = await stat(full);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }

        const matches: SearchMatch[] = [];
        let lineNo = 0;
        try {
          for await (const line of streamLines(full)) {
            lineNo++;
            const ranges = lineRanges(line, re);
            if (ranges.length === 0) continue;
            // Cap the preview text so a single minified/huge line can't bloat
            // the IPC payload (the panel only shows a short preview anyway;
            // opening a hit still uses the real column).
            const text =
              line.length > SEARCH_MAX_LINE_LEN
                ? line.slice(0, SEARCH_MAX_LINE_LEN)
                : line;
            matches.push({ line: lineNo, text, ranges });
            totalMatches += ranges.length;
            if (totalMatches >= SEARCH_MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        } catch {
          // Unreadable mid-stream — keep whatever matched before the error.
        }
        if (matches.length > 0) results.push({ path: rel, matches });
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(SEARCH_CONCURRENCY, paths.length) },
        worker,
      ),
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
