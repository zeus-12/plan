import { execFile } from "child_process";
import { promisify } from "util";
import type { GitDiffResult } from "../shared-types";

export type { GitDiffResult };

const execFileP = promisify(execFile);

/**
 * Returns the working-tree diff against HEAD for the given cwd. Includes both
 * staged and unstaged changes. Returns `available: false` if the path isn't a
 * git repo or git isn't installed.
 */
export async function getWorkingTreeDiff(cwd: string): Promise<GitDiffResult> {
  try {
    await execFileP("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { available: false, diff: "" };
  }

  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "diff", "HEAD", "--no-color"],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return { available: true, diff: stdout };
  } catch (err) {
    return {
      available: true,
      diff: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
