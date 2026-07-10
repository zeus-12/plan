import { stat } from "fs/promises";

/** Small file/path helpers shared across main-process modules. */

/** True when the path exists (any file type). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const BINARY_PROBE_BYTES = 8000;

/** True when the data looks like a binary blob (NUL byte in the sample). */
export function looksBinary(data: string | Buffer): boolean {
  const n = Math.min(data.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < n; i++) {
    const c = typeof data === "string" ? data.charCodeAt(i) : data[i];
    if (c === 0) return true;
  }
  return false;
}

/** Lowercased extension without the dot ("" when none), ignoring dot-dirs. */
export function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}
