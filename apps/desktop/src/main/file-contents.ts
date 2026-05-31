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

/**
 * Fetch the HEAD blob for `path` in `cwd`. Empty string if the path didn't
 * exist at HEAD (newly added file).
 */
async function gitShow(cwd: string, path: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "show", `HEAD:${path}`],
      { maxBuffer: 32 * 1024 * 1024 }
    );
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
    oldPath ? gitShow(cwd, oldPath) : Promise.resolve(""),
    newPath ? readWorking(cwd, newPath) : Promise.resolve(""),
  ]);
  const binary = looksBinary(oldText) || looksBinary(newText);
  return { oldText, newText, binary };
}
