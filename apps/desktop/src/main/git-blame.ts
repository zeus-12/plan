import { basename, dirname } from "path";
import { git } from "./git-exec";
import { resolveProjectFilePath } from "./project-files";
import type { BlameCommit, BlameResult, CommitDetails } from "../shared-types";

/** Run git in cwd; null on non-zero exit (blame targets can simply not exist). */
async function runGit(
  cwd: string,
  args: string[],
  stdin?: string,
): Promise<string | null> {
  const r = await git(cwd, args, stdin ? { stdin } : undefined);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Resolve a project-relative file to the directory git should run in. Running
 * in the file's own directory (not the project root) lets git discover the
 * right repo when a project holds several repos in subdirectories.
 */
async function locate(
  encoded: string,
  relPath: string,
): Promise<{ cwd: string; file: string } | null> {
  const full = await resolveProjectFilePath(encoded, relPath);
  return full ? { cwd: dirname(full), file: basename(full) } : null;
}

/** Parse `git blame --porcelain` output into per-line hashes + commit info. */
function parseBlame(
  out: string,
): Pick<BlameResult, "lineHashes" | "commits"> | null {
  const lines = out.split("\n");
  const lineHashes: string[] = [];
  const commits: Record<string, BlameCommit> = {};
  let i = 0;
  while (i < lines.length) {
    // Group header: "<hash> <origLine> <finalLine> [<numLines>]".
    const m = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const hash = m[1];
    const finalLine = parseInt(m[2], 10);
    i++;
    const commit = (commits[hash] ??= {
      hash,
      author: "",
      authorMail: "",
      authorTime: 0,
      summary: "",
    });
    // Metadata lines until the tab-prefixed content line (emitted only the
    // first time a commit appears; repeats jump straight to the content).
    while (i < lines.length && !lines[i].startsWith("\t")) {
      const line = lines[i];
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? "" : line.slice(sp + 1);
      if (key === "author") commit.author = value;
      else if (key === "author-mail")
        commit.authorMail = value.replace(/^<|>$/g, "");
      else if (key === "author-time")
        commit.authorTime = parseInt(value, 10) * 1000;
      else if (key === "summary") commit.summary = value;
      i++;
    }
    if (i < lines.length && lines[i].startsWith("\t")) i++; // content line
    lineHashes[finalLine - 1] = hash;
  }
  if (lineHashes.length === 0) return null;
  return { lineHashes, commits };
}

// user.email is effectively immutable for a repo within an app run, and blame
// re-runs on every content change — one `git config` per cwd, not per blame.
const emailByCwd = new Map<string, Promise<string | null>>();
function userEmail(cwd: string): Promise<string | null> {
  let p = emailByCwd.get(cwd);
  if (!p) {
    p = runGit(cwd, ["config", "user.email"]).then((o) => o?.trim() || null);
    emailByCwd.set(cwd, p);
  }
  return p;
}

/**
 * Blame arbitrary contents as if they were the working-tree version of the
 * file (`--contents -`). Callers blame EXACTLY the text they render (which
 * may match HEAD, the index, or the working tree), so the returned authorship
 * can never drift from what's on screen. Lines that exist only in `contents`
 * come back with the all-zero hash ("uncommitted"). Null when the file isn't
 * in a repo / isn't tracked.
 */
export async function blameContents(
  encoded: string,
  relPath: string,
  contents: string,
): Promise<BlameResult | null> {
  const loc = await locate(encoded, relPath);
  if (!loc) return null;
  const [out, email] = await Promise.all([
    runGit(
      loc.cwd,
      ["blame", "--porcelain", "--contents", "-", "--", loc.file],
      contents,
    ),
    userEmail(loc.cwd),
  ]);
  if (out == null) return null;
  const parsed = parseBlame(out);
  return parsed ? { ...parsed, userEmail: email } : null;
}

/** Full commit message for the blame hover card (the blame pass only carries the subject). */
export async function getCommitDetails(
  encoded: string,
  relPath: string,
  hash: string,
): Promise<CommitDetails | null> {
  if (!/^[0-9a-f]{4,40}$/.test(hash)) return null;
  const loc = await locate(encoded, relPath);
  if (!loc) return null;
  const out = await runGit(loc.cwd, ["show", "-s", "--format=%B", hash, "--"]);
  return out == null ? null : { message: out.trim() };
}
