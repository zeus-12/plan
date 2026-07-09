import { createHash } from "crypto";
import { access, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { app } from "electron";
import { gitShowBuffer } from "./git-exec";
import { resolveProjectCwd } from "./claude-projects";
import type { FileImageDiff } from "../shared-types";

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
