import { execFile } from "child_process";
import { createHash } from "crypto";
import { access, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { app } from "electron";
import { resolveProjectCwd } from "./claude-projects";

const execFileP = promisify(execFile);

/** Absolute filesystem paths to readable image files for each side of a diff. */
export interface FileImageDiff {
  /** "Before" image, or null when the side doesn't exist (e.g. a newly added file). */
  oldPath: string | null;
  /** "After" image, or null when the side doesn't exist (e.g. a deleted file). */
  newPath: string | null;
}

/** `git show <rev>:<path>` as raw bytes, or null if it doesn't exist there. */
async function gitShowBuffer(
  cwd: string,
  rev: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "show", `${rev}:${path}`],
      { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
    );
    return stdout as Buffer;
  } catch {
    return null;
  }
}

function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot) : "";
}

/**
 * Write a git blob's bytes to a content-addressed temp file so the renderer can
 * load it via a `file://` URL (same no-bytes-in-JS approach as transcript
 * images). Content-addressed: identical content reuses the same path, and a
 * changed blob lands at a new path, so the browser never shows a stale image.
 */
async function materialize(buf: Buffer, ext: string): Promise<string> {
  const dir = join(app.getPath("temp"), "plan-image-diff");
  await mkdir(dir, { recursive: true });
  const hash = createHash("sha1").update(buf).digest("hex");
  const full = join(dir, `${hash}${ext}`);
  try {
    await access(full);
  } catch {
    await writeFile(full, buf);
  }
  return full;
}

async function blobPath(
  cwd: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const buf = await gitShowBuffer(cwd, rev, path);
  if (!buf) return null;
  return materialize(buf, extOf(path));
}

async function workingPath(cwd: string, path: string): Promise<string | null> {
  const full = join(cwd, path);
  try {
    await access(full);
    return full;
  } catch {
    return null;
  }
}

/**
 * Resolve the before/after image files for one stage of a diff, mirroring
 * `getFileView`'s stage model:
 *   - "staged":   HEAD blob (before) vs index blob (after)
 *   - "unstaged": index blob (before) vs working file (after)
 * Git blobs are materialized to temp files; the working file is referenced in
 * place. Either side is null when it doesn't exist for that stage.
 */
export async function getFileImageDiff(
  encoded: string,
  path: string,
  mode: "staged" | "unstaged",
  subPath: string = "",
): Promise<FileImageDiff> {
  const base = await resolveProjectCwd(encoded);
  const cwd = subPath ? join(base, subPath) : base;

  if (mode === "staged") {
    const [oldPath, newPath] = await Promise.all([
      blobPath(cwd, "HEAD", path),
      blobPath(cwd, "", path), // `git show :path` → index version
    ]);
    return { oldPath, newPath };
  }
  const [oldPath, newPath] = await Promise.all([
    blobPath(cwd, "", path), // index version (or null for untracked)
    workingPath(cwd, path),
  ]);
  return { oldPath, newPath };
}
