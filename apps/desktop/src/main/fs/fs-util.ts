import { execFile } from "child_process";
import { stat } from "fs/promises";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Not fs.rm: it queues every unlink on libuv's 4-thread pool, so a 100k-file
// delete stalls every other file read in main until it finishes.
export function removeTree(path: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("rm", ["-rf", "--", path], (err) => {
      if (err) console.warn(`[removeTree] ${path}: ${err.message}`);
      resolve();
    });
  });
}

const BINARY_PROBE_BYTES = 8000;

export function looksBinary(data: string | Buffer): boolean {
  const n = Math.min(data.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < n; i++) {
    const c = typeof data === "string" ? data.charCodeAt(i) : data[i];
    if (c === 0) return true;
  }
  return false;
}

export function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}
