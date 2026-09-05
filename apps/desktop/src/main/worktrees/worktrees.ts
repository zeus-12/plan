import { rm } from "fs/promises";
import { join, basename } from "path";
import { createHash } from "crypto";
import { gitOrThrow as git, gitSafe, gh } from "@/main/git/git-exec";
import {
  resolveProjectCwd,
  primeProjectCwd,
} from "@/main/providers/claude-code/projects";
import { encodeCwd, safeSegment } from "@/main/providers/claude-code/encoding";
import { PLAN_DIR } from "@/main/store/plan-config";
import { getManualCwds } from "@/main/store/manual-projects";
import {
  discoverRepos,
  repoLayout,
  invalidateRepoLayout,
} from "@/main/git/git";
import { restartWorktreeWatch } from "./worktree-watcher";
import {
  externalWorktrees,
  invalidateExternalWorktrees,
} from "./worktree-discovery";
import { deleteScratch } from "@/main/store/scratch-store";
import { deleteNotes } from "@/main/store/notes-store";
import type { DiscoveredRepo } from "@/common/shared-types";

/**
 * Worktree checkouts live under Plan's own state dir (`~/.plan/worktrees`) so
 * they stay out of the user's project and home folders. Claude names a
 * session's transcript folder by replacing every non-alphanumeric char in the
 * cwd with "-", which `encodeCwd` mirrors, so chats started in a worktree show
 * up in its list regardless of the dot in `.plan`.
 */
const WORKTREES_ROOT = join(PLAN_DIR, "worktrees");

import {
  addWorktreeRecord,
  deleteWorktreeRecord,
  getWorktreeRecord,
  updateWorktreeRecord,
  worktreeNameTaken,
  listAllWorktreeRecords,
  getProjectDefaults,
  setProjectDefaults,
  getWorktreeNames,
  type StoredWorktree,
  type ManagedWorktreeRecord,
  type WorktreeRepoRecord,
} from "./worktrees-store";
import { latestActivity } from "@/main/providers/claude-code/sessions";
import type {
  CreatePrInput,
  CreatePrRepoResult,
  CreatePrResult,
  CreateWorktreeInput,
  AddReposToWorktreeInput,
  WorktreeRecord,
} from "@/common/shared-types";

/** Remotes configured in a repo. */
async function listRemotes(repoPath: string): Promise<string[]> {
  const r = await gitSafe(repoPath, ["remote"]);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Root dir for a project's worktrees: ~/.plan/worktrees/<basename>-<hash>/.
 * The hash of the full cwd keeps two same-named projects from colliding.
 */
async function projectWorktreesDir(encoded: string): Promise<string> {
  const cwd = await resolveProjectCwd(encoded);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(WORKTREES_ROOT, `${safeSegment(basename(cwd))}-${hash}`);
}

/** A repo plus the exact remote commit its checkout should fork from. */
interface RepoStart {
  repo: DiscoveredRepo;
  base: string;
  startSha: string;
}

/**
 * For each (repo, base), fetch the base from the repo's remote and pin the
 * exact commit fetched (FETCH_HEAD captured before the next repo's fetch
 * overwrites it — robust even for single-branch clones whose refspec wouldn't
 * update a `<remote>/<base>` ref). Worktrees fork from the *remote* tip, never
 * a possibly-stale local branch. No checkouts are made, so a failure needs no
 * rollback; instead we throw one aggregated error naming every repo whose base
 * couldn't be resolved on its remote.
 */
async function resolveRemoteStarts(
  items: { repo: DiscoveredRepo; base: string }[],
): Promise<RepoStart[]> {
  const resolved: RepoStart[] = [];
  const failures: { label: string; base: string; reason: string }[] = [];

  for (const { repo, base } of items) {
    const label = repo.subPath || "repo root";
    const remotes = await listRemotes(repo.path);
    if (remotes.length === 0) {
      failures.push({ label, base, reason: "this repo has no git remote" });
      continue;
    }
    // Honor an explicit "<remote>/<branch>" base; otherwise prefer origin.
    let remote = remotes.includes("origin") ? "origin" : remotes[0];
    let branchName = base;
    const slash = base.indexOf("/");
    if (slash > 0 && remotes.includes(base.slice(0, slash))) {
      remote = base.slice(0, slash);
      branchName = base.slice(slash + 1);
    }

    const fetched = await gitSafe(repo.path, ["fetch", remote, branchName]);
    if (!fetched.ok) {
      failures.push({
        label,
        base,
        reason:
          fetched.stderr.split("\n").filter(Boolean).pop() ||
          `couldn't fetch ${remote}/${branchName}`,
      });
      continue;
    }
    const head = await gitSafe(repo.path, ["rev-parse", "FETCH_HEAD"]);
    if (!head.ok || !head.stdout.trim()) {
      failures.push({
        label,
        base,
        reason: `couldn't resolve ${remote}/${branchName} after fetch`,
      });
      continue;
    }
    resolved.push({ repo, base, startSha: head.stdout.trim() });
  }

  if (failures.length > 0) {
    const lines = failures
      .map((f) => `  • ${f.label} — base "${f.base}": ${f.reason}`)
      .join("\n");
    throw new Error(
      `Couldn't fork the base branch from the remote in ${failures.length} of ` +
        `${items.length} repo(s):\n\n${lines}\n\n` +
        `Pick a base that exists on each repo's remote and try again.`,
    );
  }
  return resolved;
}

/**
 * `git worktree add -b <branch> <path> <sha>` for each start, under `rootPath`.
 * On any failure, only the checkouts *this call* created are rolled back (the
 * caller's pre-existing checkouts are left untouched), then the error rethrows.
 */
async function addCheckouts(
  starts: RepoStart[],
  rootPath: string,
  branch: string,
): Promise<WorktreeRepoRecord[]> {
  const created: WorktreeRepoRecord[] = [];
  try {
    for (const { repo, base, startSha } of starts) {
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
        startSha,
      ]);
      created.push({ subPath: repo.subPath, path: checkoutPath, branch, base });
    }
  } catch (err) {
    for (const c of created) {
      const src = starts.find((s) => s.repo.subPath === c.subPath);
      if (src) {
        await git(src.repo.path, [
          "worktree",
          "remove",
          "--force",
          c.path,
        ]).catch(() => {});
      }
    }
    throw err;
  }
  return created;
}

/**
 * Create a worktree spanning the chosen repos (one `git worktree add` per repo,
 * each forked from the remote tip of its base — see `resolveRemoteStarts`).
 * `input.repos` selects which repos to span (default: all discovered). If the
 * base can't be resolved on the remote in any repo, nothing is created and the
 * error names every offending repo. On a later failure, the partially-created
 * checkouts are rolled back. A successful create stores `input.base` as the
 * project's default, so the next New-worktree modal pre-fills it.
 */
export async function createWorktree(
  encoded: string,
  input: CreateWorktreeInput,
): Promise<ManagedWorktreeRecord> {
  const name = input.name.trim();
  const branch = input.branch.trim();
  const base = input.base.trim();
  if (!name) throw new Error("Worktree name is required.");
  if (!branch) throw new Error("Branch name is required.");
  if (!base) throw new Error("Base branch is required.");
  if (await worktreeNameTaken(encoded, name)) {
    throw new Error(`A worktree named "${name}" already exists.`);
  }

  const all = await discoverRepos(encoded);
  if (all.length === 0) {
    throw new Error("No git repositories found in this project.");
  }
  const repos = input.repos
    ? all.filter((r) => input.repos!.includes(r.subPath))
    : all;
  if (repos.length === 0) {
    throw new Error("Select at least one repo for the worktree.");
  }

  const starts = await resolveRemoteStarts(
    repos.map((repo) => ({
      repo,
      base: input.bases?.[repo.subPath]?.trim() || base,
    })),
  );

  const rootPath = join(await projectWorktreesDir(encoded), safeSegment(name));
  let created: WorktreeRepoRecord[];
  try {
    created = await addCheckouts(starts, rootPath, branch);
  } catch (err) {
    // The whole rootPath is ours and brand-new here, so clean it entirely.
    await rm(rootPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const wtEncoded = encodeCwd(rootPath);
  primeProjectCwd(wtEncoded, rootPath);
  // The checkouts just landed — drop any layout discovered before they existed.
  invalidateRepoLayout(wtEncoded);
  invalidateExternalWorktrees();
  const record = await addWorktreeRecord({
    projectEncoded: encoded,
    name,
    rootPath,
    encoded: wtEncoded,
    repos: created,
  });
  const defaults = await getProjectDefaults(encoded);
  if (defaults.base !== base) {
    await setProjectDefaults(encoded, { ...defaults, base });
  }
  return withActivity(record);
}

/**
 * Add repos the worktree doesn't yet span. New checkouts reuse the worktree's
 * existing branch name (a worktree is one branch across its repos) forked from
 * each chosen base's remote tip, and are appended to the record. Repos already
 * in the worktree are ignored. On any failure the just-added checkouts roll
 * back; the existing ones are never touched.
 */
export async function addReposToWorktree(
  id: string,
  input: AddReposToWorktreeInput,
): Promise<ManagedWorktreeRecord> {
  const rec = await getWorktreeRecord(id);
  if (!rec) throw new Error("Worktree not found.");
  const branch = rec.repos[0]?.branch;
  if (!branch) throw new Error("This worktree has no branch to extend.");

  const all = await discoverRepos(rec.projectEncoded);
  const have = new Set(rec.repos.map((r) => r.subPath));
  const wanted = new Set(Object.keys(input.bases));
  const toAdd = all.filter(
    (r) => wanted.has(r.subPath) && !have.has(r.subPath),
  );
  if (toAdd.length === 0) {
    throw new Error("No new repos to add to this worktree.");
  }
  for (const r of toAdd) {
    if (!input.bases[r.subPath]?.trim()) {
      throw new Error(
        `Base branch is required for "${r.subPath || "repo root"}".`,
      );
    }
  }

  const starts = await resolveRemoteStarts(
    toAdd.map((repo) => ({ repo, base: input.bases[repo.subPath].trim() })),
  );
  const created = await addCheckouts(starts, rec.rootPath, branch);
  // The worktree spans more repos now — its cached layout is stale, and the
  // file watcher's roots (one git dir per repo) were resolved from that layout.
  invalidateRepoLayout(rec.encoded);
  invalidateExternalWorktrees();
  await restartWorktreeWatch(rec.encoded);

  const updated: StoredWorktree = { ...rec, repos: [...rec.repos, ...created] };
  await updateWorktreeRecord(updated);
  return withActivity(updated);
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
  // Drop its scratchpad and note stash too — a future worktree reusing the same
  // name (and hence the same encoded path) must not inherit stale notes.
  await deleteScratch(rec.encoded).catch(() => {});
  await deleteNotes(rec.encoded).catch(() => {});
  invalidateRepoLayout(rec.encoded);
  invalidateExternalWorktrees();
  await deleteWorktreeRecord(id);
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

    // A PR needs at least one commit ahead of base. A repo with none isn't an
    // error — the user just didn't touch it in this worktree — so mark it
    // skipped and move on (also avoids a pointless push and gh's cryptic
    // GraphQL "No commits between …" error). If we can't determine it (e.g. base
    // ref is missing locally), fall through and let gh be the judge.
    try {
      const out = await git(repo.path, [
        "rev-list",
        "--count",
        `${base}..HEAD`,
      ]);
      if (parseInt(out.trim() || "0", 10) === 0) {
        repos.push({ subPath: repo.subPath, label, skipped: true });
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

/**
 * A worktree addresses its chats by its own `encoded` cwd, so the activity
 * clock behind `ProjectEntry.mtimeMs` reads it unchanged: newest session
 * transcript wins, 0 when the worktree has never been chatted in.
 */
async function withActivity<T extends { encoded: string }>(
  rec: T,
): Promise<T & { mtimeMs: number }> {
  return { ...rec, mtimeMs: await latestActivity(rec.encoded) };
}

/**
 * Discovery reads repo locations only, never a live branch, so this takes the
 * cached `repoLayout` rather than `discoverRepos` — the latter spawns a
 * `rev-parse` per repo on every call, and the sidebar calls this per project on
 * every watcher tick.
 *
 * `allManaged` spans every project, not just this one: two added projects can
 * share a source repo, and a worktree Plan created under one of them is still
 * Plan-managed when it turns up in the other's `git worktree list`.
 */
async function hydrateProjectWorktrees({
  encoded,
  records,
  allManaged,
  manualRoots,
  names,
}: {
  encoded: string;
  /** This project's own managed worktrees — what it renders. */
  records: StoredWorktree[];
  /** Every project's, for the exclusion set. */
  allManaged: StoredWorktree[];
  manualRoots: string[];
  names: Record<string, string>;
}): Promise<WorktreeRecord[]> {
  const external = await externalWorktrees({
    projectEncoded: encoded,
    repos: await repoLayout(encoded),
    managed: allManaged,
    manualRoots,
  });

  // Re-seed the cwd cache after a restart so content ops resolve immediately.
  for (const record of [...records, ...external])
    primeProjectCwd(record.encoded, record.rootPath);

  const [managedWithActivity, externalWithActivity] = await Promise.all([
    Promise.all(records.map(withActivity)),
    Promise.all(external.map(withActivity)),
  ]);
  return [...managedWithActivity, ...externalWithActivity].map((record) =>
    named(record, names),
  );
}

/**
 * Apply the user's display name. Only the label moves — `rootPath`, `encoded`
 * and the branch are untouched, so a renamed worktree keeps its checkout and
 * its chats.
 */
function named(
  record: WorktreeRecord,
  names: Record<string, string>,
): WorktreeRecord {
  const name = names[record.rootPath];
  return name ? { ...record, name } : record;
}

export async function listWorktrees(
  encoded: string,
): Promise<WorktreeRecord[]> {
  const [allManaged, manualRoots, names] = await Promise.all([
    listAllWorktreeRecords(),
    getManualCwds(),
    getWorktreeNames(),
  ]);
  return hydrateProjectWorktrees({
    encoded,
    records: allManaged.filter((record) => record.projectEncoded === encoded),
    allManaged,
    manualRoots,
    names,
  });
}

/**
 * Every worktree across all projects, for the merged project sidebar (which
 * nests each project's worktrees beneath it). Primes the cwd cache for all so
 * their content/git/pty ops resolve immediately after a restart.
 */
export async function listAllWorktrees(): Promise<WorktreeRecord[]> {
  const [records, manualRoots, names] = await Promise.all([
    listAllWorktreeRecords(),
    getManualCwds(),
    getWorktreeNames(),
  ]);
  const encodeds = new Set(records.map((record) => record.projectEncoded));
  for (const root of manualRoots) {
    const encoded = encodeCwd(root);
    primeProjectCwd(encoded, root);
    encodeds.add(encoded);
  }

  const byProject = await Promise.all(
    [...encodeds].map((encoded) =>
      hydrateProjectWorktrees({
        encoded,
        records: records.filter((r) => r.projectEncoded === encoded),
        allManaged: records,
        manualRoots,
        names,
      }),
    ),
  );
  return byProject.flat();
}
