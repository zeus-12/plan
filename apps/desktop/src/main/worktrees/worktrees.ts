import { mkdir, readdir, realpath, rename } from "fs/promises";
import { join, basename } from "path";
import { createHash, randomUUID } from "crypto";
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
import { removeTree } from "@/main/fs/fs-util";
import { restartWorktreeWatch } from "./worktree-watcher";
import {
  externalWorktrees,
  invalidateExternalWorktrees,
} from "./worktree-discovery";
import { deleteScratch } from "@/main/store/scratch-store";
import { deleteNotes } from "@/main/store/notes-store";
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
  DiscoveredRepo,
  WorktreeRecord,
} from "@/common/shared-types";

const WORKTREES_ROOT = join(PLAN_DIR, "worktrees");
// Inside WORKTREES_ROOT so moving a checkout here is a same-volume rename.
const TRASH_DIR = join(WORKTREES_ROOT, ".trash");

async function listRemotes(repoPath: string): Promise<string[]> {
  const r = await gitSafe(repoPath, ["remote"]);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The cwd hash keeps two same-named projects from colliding.
async function projectWorktreesDir(encoded: string): Promise<string> {
  const cwd = await resolveProjectCwd(encoded);
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(WORKTREES_ROOT, `${safeSegment(basename(cwd))}-${hash}`);
}

// Two entries sharing a git dir (two checkouts of one repo) run one after the
// other: concurrent fetch/worktree ops in one repo fail on its ref locks.
async function acrossRepos<T, R>(
  items: T[],
  commonDir: (item: T) => string,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const lanes = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = commonDir(item);
    lanes.set(key, [...(lanes.get(key) ?? []), i]);
  });
  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      for (const i of lane) {
        try {
          results[i] = { status: "fulfilled", value: await run(items[i]) };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

interface RepoStart {
  repo: DiscoveredRepo;
  base: string;
  startSha: string;
}

type StartOutcome = { start: RepoStart } | { reason: string };

// Pins FETCH_HEAD rather than `<remote>/<base>`: a single-branch clone's
// refspec never updates that ref, so it can sit on a stale commit.
async function resolveRemoteStart(
  repo: DiscoveredRepo,
  base: string,
): Promise<StartOutcome> {
  const remotes = await listRemotes(repo.path);
  if (remotes.length === 0) return { reason: "this repo has no git remote" };
  let remote = remotes.includes("origin") ? "origin" : remotes[0];
  let branchName = base;
  const slash = base.indexOf("/");
  if (slash > 0 && remotes.includes(base.slice(0, slash))) {
    remote = base.slice(0, slash);
    branchName = base.slice(slash + 1);
  }

  const fetched = await gitSafe(repo.path, ["fetch", remote, branchName]);
  if (!fetched.ok) {
    return {
      reason:
        fetched.stderr.split("\n").filter(Boolean).pop() ||
        `couldn't fetch ${remote}/${branchName}`,
    };
  }
  const head = await gitSafe(repo.path, ["rev-parse", "FETCH_HEAD"]);
  if (!head.ok || !head.stdout.trim()) {
    return { reason: `couldn't resolve ${remote}/${branchName} after fetch` };
  }
  return { start: { repo, base, startSha: head.stdout.trim() } };
}

async function resolveRemoteStarts(
  items: { repo: DiscoveredRepo; base: string }[],
): Promise<RepoStart[]> {
  const outcomes = await acrossRepos(
    items,
    (item) => item.repo.commonDir,
    (item) => resolveRemoteStart(item.repo, item.base),
  );

  const resolved: RepoStart[] = [];
  const failures: string[] = [];
  outcomes.forEach((outcome, i) => {
    const value: StartOutcome =
      outcome.status === "fulfilled"
        ? outcome.value
        : { reason: String(outcome.reason) };
    if ("start" in value) {
      resolved.push(value.start);
      return;
    }
    const { repo, base } = items[i];
    failures.push(
      `  • ${repo.subPath || "repo root"} — base "${base}": ${value.reason}`,
    );
  });

  if (failures.length > 0) {
    throw new Error(
      `Couldn't fork the base branch from the remote in ${failures.length} of ` +
        `${items.length} repo(s):\n\n${failures.join("\n")}\n\n` +
        `Pick a base that exists on each repo's remote and try again.`,
    );
  }
  return resolved;
}

// On any failure only the checkouts this call created are rolled back.
async function addCheckouts(
  starts: RepoStart[],
  rootPath: string,
  branch: string,
): Promise<WorktreeRepoRecord[]> {
  const results = await acrossRepos(
    starts,
    (s) => s.repo.commonDir,
    async ({ repo, base, startSha }): Promise<WorktreeRepoRecord> => {
      const checkoutPath = repo.subPath
        ? join(rootPath, repo.subPath)
        : rootPath;
      await git(repo.path, [
        "worktree",
        "add",
        "-b",
        branch,
        checkoutPath,
        startSha,
      ]);
      return { subPath: repo.subPath, path: checkoutPath, branch, base };
    },
  );

  const created = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  const failed = results.find((r) => r.status === "rejected");
  if (!failed) return created;

  await Promise.all(
    results.map((r, i) =>
      r.status === "fulfilled"
        ? git(starts[i].repo.path, [
            "worktree",
            "remove",
            "--force",
            r.value.path,
          ]).catch(() => {})
        : undefined,
    ),
  );
  throw failed.reason;
}

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
    await removeTree(rootPath);
    throw err;
  }

  const wtEncoded = encodeCwd(rootPath);
  primeProjectCwd(wtEncoded, rootPath);
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

// New checkouts reuse the worktree's branch name: a worktree is one branch
// across its repos.
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
  // The watcher resolved its git-dir roots from the old layout.
  invalidateRepoLayout(rec.encoded);
  invalidateExternalWorktrees();
  await restartWorktreeWatch(rec.encoded);

  const updated: StoredWorktree = { ...rec, repos: [...rec.repos, ...created] };
  await updateWorktreeRecord(updated);
  return withActivity(updated);
}

async function moveToTrash(path: string): Promise<string> {
  await mkdir(TRASH_DIR, { recursive: true });
  const trashed = join(TRASH_DIR, `${basename(path)}-${randomUUID()}`);
  await rename(path, trashed);
  return trashed;
}

// Leftovers from a delete the app quit in the middle of.
export async function sweepWorktreeTrash(): Promise<void> {
  const entries = await readdir(TRASH_DIR).catch(() => [] as string[]);
  await Promise.all(entries.map((e) => removeTree(join(TRASH_DIR, e))));
}

// The checkout moves to trash first, so git only unregisters a missing path
// (metadata, instant) and the file delete runs in the background.
export async function removeWorktree(id: string): Promise<void> {
  const rec = await getWorktreeRecord(id);
  if (!rec) return;
  // git keys a checkout by its real path; once the dir is gone, a path behind a
  // symlink (/tmp → /private/tmp) can no longer be resolved to that record.
  const realPaths = await Promise.all(
    rec.repos.map((r) => realpath(r.path).catch(() => r.path)),
  );
  const trashed = await moveToTrash(rec.rootPath).catch(() => null);

  const sources = await repoLayout(rec.projectEncoded);
  const checkouts = rec.repos.flatMap((r, i) => {
    const source = sources.find((s) => s.subPath === r.subPath);
    return source ? [{ source, path: realPaths[i] }] : [];
  });
  await acrossRepos(
    checkouts,
    (c) => c.source.commonDir,
    (c) => git(c.source.path, ["worktree", "remove", "--force", c.path]),
  );

  // Not backgrounded when in place: a worktree re-created under the same name
  // would land in the path a late `rm -rf` is still deleting.
  if (trashed) void removeTree(trashed);
  else await removeTree(rec.rootPath);

  // A future worktree reusing this name must not inherit stale notes.
  await deleteScratch(rec.encoded).catch(() => {});
  await deleteNotes(rec.encoded).catch(() => {});
  invalidateRepoLayout(rec.encoded);
  invalidateExternalWorktrees();
  await deleteWorktreeRecord(id);
}

function firstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}

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

    // No commits ahead of base = untouched repo, not an error (and gh would
    // fail with a cryptic "No commits between …").
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

async function withActivity<T extends { encoded: string }>(
  rec: T,
): Promise<T & { mtimeMs: number }> {
  return { ...rec, mtimeMs: await latestActivity(rec.encoded) };
}

// `allManaged` spans every project: two projects can share a source repo, so a
// worktree managed under one still shows up in the other's `git worktree list`.
async function hydrateProjectWorktrees({
  encoded,
  records,
  allManaged,
  manualRoots,
  names,
}: {
  encoded: string;
  records: StoredWorktree[];
  allManaged: StoredWorktree[];
  manualRoots: string[];
  names: Record<string, string>;
}): Promise<WorktreeRecord[]> {
  // repoLayout, not discoverRepos: this runs per project on every watcher tick.
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
