import { execFile } from "child_process";
import { promisify } from "util";
import { rm } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { resolveProjectCwd, primeProjectCwd } from "./claude-projects";
import { encodeCwd } from "./manual-projects";
import { discoverRepos } from "./git";

/**
 * Worktree checkouts live here. Deliberately dot/space-free: Claude names a
 * session's transcript folder by replacing every non-alphanumeric char in the
 * cwd with "-", so keeping the path to "/" + alphanumerics + "-" makes our
 * `encodeCwd` (which only maps "/" → "-") provably equal to Claude's encoding.
 * That equality is what lets chats started in a worktree show up in its list.
 */
const WORKTREES_ROOT = join(homedir(), "plan-worktrees");

/** Reduce a path segment to chars where our encoding == Claude's (no "." etc). */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}
import {
  addWorktreeRecord,
  deleteWorktreeRecord,
  getWorktreeRecord,
  listWorktreeRecords,
  worktreeNameTaken,
  type WorktreeRecord,
  type WorktreeRepoRecord,
} from "./worktrees-store";
import type {
  CreatePrInput,
  CreatePrRepoResult,
  CreatePrResult,
} from "../shared-types";

const execFileP = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Run git in `cwd`; throws on non-zero exit with stderr in the message. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error((e.stderr || e.message || "git failed").trim());
  }
}

/**
 * Root dir for a project's worktrees: ~/plan-worktrees/<basename>-<hash>/.
 * The hash of the full cwd keeps two same-named projects from colliding.
 */
async function projectWorktreesDir(encoded: string): Promise<string> {
  const cwd = await resolveProjectCwd(encoded);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(WORKTREES_ROOT, `${safeSegment(basename(cwd))}-${hash}`);
}

export interface CreateWorktreeInput {
  name: string;
  branch: string;
  base: string;
}

/**
 * Create a worktree across every repo discovered in the project (one
 * `git worktree add` per repo, all on the same branch off the same base). On
 * any repo's failure, the partially-created checkouts are rolled back.
 */
export async function createWorktree(
  encoded: string,
  input: CreateWorktreeInput,
): Promise<WorktreeRecord> {
  const name = input.name.trim();
  const branch = input.branch.trim();
  const base = input.base.trim();
  if (!name) throw new Error("Worktree name is required.");
  if (!branch) throw new Error("Branch name is required.");
  if (!base) throw new Error("Base branch is required.");
  if (await worktreeNameTaken(encoded, name)) {
    throw new Error(`A worktree named "${name}" already exists.`);
  }

  const repos = await discoverRepos(encoded);
  if (repos.length === 0) {
    throw new Error("No git repositories found in this project.");
  }

  const rootPath = join(await projectWorktreesDir(encoded), safeSegment(name));
  const created: WorktreeRepoRecord[] = [];

  try {
    for (const repo of repos) {
      const checkoutPath = repo.subPath
        ? join(rootPath, repo.subPath)
        : rootPath;
      // -b creates the branch; fails loudly if it already exists, which is the
      // safe default (the user picks a fresh branch name).
      await git(repo.path, [
        "worktree",
        "add",
        "-b",
        branch,
        checkoutPath,
        base,
      ]);
      created.push({ subPath: repo.subPath, path: checkoutPath, branch, base });
    }
  } catch (err) {
    // Roll back anything we managed to create so we don't leave orphans.
    for (const c of created) {
      const source = repos.find((r) => r.subPath === c.subPath);
      if (source) {
        await git(source.path, ["worktree", "remove", "--force", c.path]).catch(
          () => {},
        );
      }
    }
    await rm(rootPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const wtEncoded = encodeCwd(rootPath);
  primeProjectCwd(wtEncoded, rootPath);
  return addWorktreeRecord({
    projectEncoded: encoded,
    name,
    rootPath,
    encoded: wtEncoded,
    repos: created,
  });
}

/** Remove a worktree's checkouts (per repo) and its on-disk dir, then forget it. */
export async function removeWorktree(id: string): Promise<void> {
  const rec = await getWorktreeRecord(id);
  if (!rec) return;
  const repos = await discoverRepos(rec.projectEncoded);
  for (const r of rec.repos) {
    const source = repos.find((s) => s.subPath === r.subPath);
    if (source) {
      await git(source.path, ["worktree", "remove", "--force", r.path]).catch(
        () => {},
      );
    }
  }
  await rm(rec.rootPath, { recursive: true, force: true }).catch(() => {});
  await deleteWorktreeRecord(id);
}

/** Run `gh` in `cwd`; never throws — non-zero exit is captured for the caller. */
async function gh(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP("gh", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: (e.stderr || e.message || "gh failed").trim(),
    };
  }
}

/** First http(s) URL in a string (gh prints the PR URL on stdout). */
function firstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}

/**
 * Open a GitHub PR for each repo the worktree spans. Per repo we push the
 * branch (a PR needs its head on the remote) then `gh pr create`. If a PR is
 * already open for that branch we surface its URL instead of failing. Results
 * are reported per repo so partial success on multi-repo worktrees is honest.
 */
export async function createWorktreePr(
  id: string,
  input: CreatePrInput,
): Promise<CreatePrResult> {
  const rec = await getWorktreeRecord(id);
  if (!rec) throw new Error("Worktree not found.");
  const title = input.title.trim();
  const base = input.base.trim();
  const body = input.body;
  if (!title) throw new Error("PR title is required.");
  if (!base) throw new Error("Base branch is required.");

  const repos: CreatePrRepoResult[] = [];
  for (const repo of rec.repos) {
    const label = repo.subPath || "repo root";

    // A PR needs at least one commit ahead of base. Guard up front with a clear
    // message (and skip the pointless push) instead of gh's cryptic GraphQL
    // "No commits between …" error. If we can't determine it (e.g. base ref is
    // missing locally), fall through and let gh be the judge.
    try {
      const out = await git(repo.path, [
        "rev-list",
        "--count",
        `${base}..HEAD`,
      ]);
      if (parseInt(out.trim() || "0", 10) === 0) {
        repos.push({
          subPath: repo.subPath,
          label,
          error: `No commits on "${repo.branch}" since "${base}" yet — commit your changes before opening a PR.`,
        });
        continue;
      }
    } catch {
      // base ref not resolvable here — defer to gh below.
    }

    // Push the branch first — gh needs the head ref on origin.
    try {
      await git(repo.path, ["push", "--set-upstream", "origin", repo.branch]);
    } catch (err) {
      repos.push({
        subPath: repo.subPath,
        label,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const created = await gh(repo.path, [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      repo.branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    if (created.ok) {
      repos.push({
        subPath: repo.subPath,
        label,
        url: firstUrl(created.stdout),
      });
      continue;
    }

    // A PR may already be open for this branch — return its URL rather than error.
    if (/already exists/i.test(created.stderr)) {
      const existing = await gh(repo.path, [
        "pr",
        "view",
        repo.branch,
        "--json",
        "url",
        "-q",
        ".url",
      ]);
      if (existing.ok) {
        repos.push({
          subPath: repo.subPath,
          label,
          url: existing.stdout.trim(),
          existed: true,
        });
        continue;
      }
    }

    repos.push({ subPath: repo.subPath, label, error: created.stderr });
  }

  return { repos };
}

export async function listWorktrees(
  encoded: string,
): Promise<WorktreeRecord[]> {
  const records = await listWorktreeRecords(encoded);
  // Re-seed the cwd cache after a restart so content ops resolve immediately.
  for (const r of records) primeProjectCwd(r.encoded, r.rootPath);
  return records;
}
