import { readFile } from "fs/promises";
import { join } from "path";
import { git, gitShow } from "./git-exec";
import { looksBinary } from "./fs-util";
import { resolveWorkspaceCwd } from "./workspace";
import type { FileContents, FileView } from "../shared-types";

/** Unified diff for one file in one stage; "" when git fails (e.g. no repo). */
async function gitDiff(
  cwd: string,
  path: string,
  cached: boolean,
): Promise<string> {
  const args = ["diff", "--no-color"];
  if (cached) args.push("--cached");
  args.push("--", path);
  const r = await git(cwd, args);
  return r.code === 0 ? r.stdout : "";
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
  subPath: string = "",
): Promise<FileContents> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const [oldText, newText] = await Promise.all([
    oldPath ? gitShow(cwd, "HEAD", oldPath) : Promise.resolve(""),
    newPath ? readWorking(cwd, newPath) : Promise.resolve(""),
  ]);
  const binary = looksBinary(oldText) || looksBinary(newText);
  return { oldText, newText, binary };
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
  subPath: string = "",
): Promise<FileView> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);

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
