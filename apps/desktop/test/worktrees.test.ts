import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Every store path derives from os.homedir(), which reads HOME — so the module
// graph is imported only after HOME points at a scratch dir. HOME is a symlink
// so stored worktree paths differ from the real paths git records.
const home = realpathSync(mkdtempSync(join(tmpdir(), "plan-worktrees-")));
const homeLink = `${home}-link`;
symlinkSync(home, homeLink);
process.env.HOME = homeLink;

type Worktrees = typeof import("@/main/worktrees/worktrees");
let wt: Worktrees;
let encodeCwd: (cwd: string) => string;
let primeProjectCwd: (encoded: string, cwd: string) => void;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commit(repo: string, message: string) {
  git(repo, "commit", "--allow-empty", "-m", message);
}

function makeProject(name: string, repos: string[]) {
  const root = join(home, "projects", name);
  mkdirSync(root, { recursive: true });
  for (const repo of repos) {
    const remote = join(home, "remotes", name, `${repo}.git`);
    mkdirSync(remote, { recursive: true });
    git(remote, "init", "--bare", "-b", "main");
    const seed = join(home, "seeds", name, repo);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-b", "main");
    commit(seed, "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "origin", "main");
    git(root, "clone", "-q", remote, repo);
  }
  const encoded = encodeCwd(root);
  primeProjectCwd(encoded, root);
  return { root, encoded };
}

function registeredWorktrees(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

beforeAll(async () => {
  wt = await import("@/main/worktrees/worktrees");
  ({ encodeCwd } = await import("@/main/providers/claude-code/encoding"));
  ({ primeProjectCwd } = await import("@/main/providers/claude-code/projects"));
});

afterAll(() => {
  rmSync(homeLink, { force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("forks every repo from its remote tip, not the stale local branch", async () => {
    const { root, encoded } = makeProject("fresh", ["api", "web"]);
    for (const repo of ["api", "web"]) {
      commit(join(home, "seeds", "fresh", repo), "landed after the clone");
      git(join(home, "seeds", "fresh", repo), "push", "origin", "main");
    }

    const rec = await wt.createWorktree(encoded, {
      name: "feat",
      branch: "feat",
      base: "main",
    });

    expect(rec.repos.map((r) => r.subPath)).toEqual(["api", "web"]);
    for (const repo of rec.repos) {
      const remoteTip = git(
        join(home, "remotes", "fresh", `${repo.subPath}.git`),
        "rev-parse",
        "main",
      );
      expect(git(repo.path, "rev-parse", "HEAD")).toBe(remoteTip);
      expect(git(repo.path, "rev-parse", "HEAD")).not.toBe(
        git(join(root, repo.subPath), "rev-parse", "main"),
      );
    }
  });

  it("names every repo whose base is missing and creates nothing", async () => {
    const { root, encoded } = makeProject("missing-base", ["api", "web"]);

    await expect(
      wt.createWorktree(encoded, {
        name: "feat",
        branch: "feat",
        base: "main",
        bases: { api: "nope", web: "also-nope" },
      }),
    ).rejects.toThrow(/2 of 2 repo\(s\)[\s\S]*api[\s\S]*web/);

    for (const repo of ["api", "web"]) {
      expect(registeredWorktrees(join(root, repo))).toHaveLength(1);
    }
  });

  it("rolls back the checkouts that landed when another repo's fails", async () => {
    const { root, encoded } = makeProject("rollback", ["api", "web"]);
    git(join(root, "web"), "branch", "feat");

    await expect(
      wt.createWorktree(encoded, {
        name: "feat",
        branch: "feat",
        base: "main",
      }),
    ).rejects.toThrow(/feat/);

    expect(registeredWorktrees(join(root, "api"))).toHaveLength(1);
    expect(registeredWorktrees(join(root, "web"))).toHaveLength(1);
    const worktreesRoot = join(home, ".plan", "worktrees");
    const projectDirs = readdirSync(worktreesRoot).filter((d) =>
      d.startsWith("rollback-"),
    );
    for (const dir of projectDirs) {
      expect(existsSync(join(worktreesRoot, dir, "feat"))).toBe(false);
    }
  });
});

describe("removeWorktree", () => {
  it("unregisters every checkout, even behind a symlinked home, and keeps the branch", async () => {
    const { root, encoded } = makeProject("remove", ["api", "web"]);
    const rec = await wt.createWorktree(encoded, {
      name: "feat",
      branch: "feat",
      base: "main",
    });

    await wt.removeWorktree(rec.id);

    expect(existsSync(rec.rootPath)).toBe(false);
    for (const repo of ["api", "web"]) {
      expect(registeredWorktrees(join(root, repo))).toEqual([join(root, repo)]);
      expect(git(join(root, repo), "branch", "--list", "feat")).toContain(
        "feat",
      );
    }

    await wt.sweepWorktreeTrash();
    expect(readdirSync(join(home, ".plan", "worktrees", ".trash"))).toEqual([]);
  });

  it("lets a worktree be re-created under the name just removed", async () => {
    const { encoded } = makeProject("recreate", ["api"]);
    const first = await wt.createWorktree(encoded, {
      name: "feat",
      branch: "feat",
      base: "main",
    });
    await wt.removeWorktree(first.id);

    const second = await wt.createWorktree(encoded, {
      name: "feat",
      branch: "feat-2",
      base: "main",
    });

    expect(second.rootPath).toBe(first.rootPath);
    await wt.sweepWorktreeTrash();
    expect(existsSync(join(second.rootPath, "api", ".git"))).toBe(true);
  });
});
