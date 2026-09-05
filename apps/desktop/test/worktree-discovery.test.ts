import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverExternalWorktrees,
  externalWorktrees,
  invalidateExternalWorktrees,
  parseGitWorktrees,
} from "@/main/worktrees/worktree-discovery";

function porcelain(...records: string[][]): string {
  return records.map((fields) => `${fields.join("\0")}\0\0`).join("");
}

describe("parseGitWorktrees", () => {
  it("parses branch and detached entries from NUL-delimited porcelain", () => {
    const output = porcelain(
      [
        "worktree /repos/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
      ],
      [
        "worktree /repos/review copy",
        "HEAD 2222222222222222222222222222222222222222",
        "detached",
      ],
    );

    expect(parseGitWorktrees(output)).toEqual([
      {
        path: "/repos/main",
        head: "1111111111111111111111111111111111111111",
        branch: "main",
        prunable: false,
        bare: false,
      },
      {
        path: "/repos/review copy",
        head: "2222222222222222222222222222222222222222",
        branch: null,
        prunable: false,
        bare: false,
      },
    ]);
  });

  it("preserves paths containing newlines and records unusable entries", () => {
    const output = porcelain(
      [
        "worktree /repos/line\nbreak",
        "HEAD 3333333333333333333333333333333333333333",
        "prunable gitdir file points to non-existent location",
      ],
      ["worktree /repos/bare.git", "bare"],
    );

    expect(parseGitWorktrees(output)).toEqual([
      {
        path: "/repos/line\nbreak",
        head: "3333333333333333333333333333333333333333",
        branch: null,
        prunable: true,
        bare: false,
      },
      {
        path: "/repos/bare.git",
        head: "",
        branch: null,
        prunable: false,
        bare: true,
      },
    ]);
  });

  it("flushes a final record even when Git output lacks its blank terminator", () => {
    expect(
      parseGitWorktrees(
        "worktree /repos/final\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual([
      {
        path: "/repos/final",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: null,
        prunable: false,
        bare: false,
      },
    ]);
  });
});

describe("discoverExternalWorktrees", () => {
  it("finds a checkout made outside Plan and excludes manually-added roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-worktree-discovery-"));
    const source = join(root, "source");
    const review = join(root, "review");
    const runGit = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

    try {
      mkdirSync(source);
      runGit(source, ["init", "-b", "main"]);
      writeFileSync(join(source, "README.md"), "test\n");
      runGit(source, ["add", "README.md"]);
      runGit(source, [
        "-c",
        "user.name=Plan Test",
        "-c",
        "user.email=plan@example.invalid",
        "commit",
        "-m",
        "Initial",
      ]);
      runGit(source, ["worktree", "add", "-b", "review-branch", review]);

      const input = {
        projectEncoded: "-test-source",
        repos: [{ path: source, subPath: "", commonDir: join(source, ".git") }],
        managed: [],
        manualRoots: [source],
      };
      const found = await discoverExternalWorktrees(input);

      expect(found.map((worktree) => worktree.rootPath)).toEqual([
        realpathSync(review),
      ]);
      expect(found[0]).toMatchObject({
        kind: "external",
        name: "review-branch",
        rootPath: realpathSync(review),
        repos: [{ path: realpathSync(review), branch: "review-branch" }],
      });
      expect(found[0].id).toMatch(/^external:[a-f0-9]{16}$/);

      await expect(
        discoverExternalWorktrees({
          ...input,
          manualRoots: [source, review],
        }),
      ).resolves.toEqual([]);

      await expect(
        discoverExternalWorktrees({
          ...input,
          managed: [
            {
              kind: "managed",
              id: "managed-review",
              projectEncoded: input.projectEncoded,
              name: "review",
              rootPath: review,
              encoded: "-test-review",
              repos: [
                {
                  subPath: "",
                  path: review,
                  branch: "review-branch",
                  base: "main",
                },
              ],
              createdAt: 1,
            },
          ],
        }),
      ).resolves.toEqual([]);
      // A worktree Plan created under a *different* project is still
      // Plan-managed when it surfaces in this project's `git worktree list`.
      await expect(
        discoverExternalWorktrees({
          ...input,
          managed: [
            {
              kind: "managed",
              id: "managed-elsewhere",
              projectEncoded: "-some-other-project",
              name: "review",
              rootPath: review,
              encoded: "-test-review",
              repos: [
                {
                  subPath: "",
                  path: review,
                  branch: "review-branch",
                  base: "main",
                },
              ],
              createdAt: 1,
            },
          ],
        }),
      ).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves repeat sweeps from cache until inputs change or it is invalidated", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-worktree-cache-"));
    const source = join(root, "source");
    const review = join(root, "review");
    const runGit = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

    try {
      mkdirSync(source);
      runGit(source, ["init", "-b", "main"]);
      writeFileSync(join(source, "README.md"), "test\n");
      runGit(source, ["add", "README.md"]);
      runGit(source, [
        "-c",
        "user.name=Plan Test",
        "-c",
        "user.email=plan@example.invalid",
        "commit",
        "-m",
        "Initial",
      ]);

      const input = {
        projectEncoded: "-test-cache",
        repos: [{ path: source, subPath: "", commonDir: join(source, ".git") }],
        managed: [],
        manualRoots: [source],
      };
      invalidateExternalWorktrees();

      expect(await externalWorktrees(input)).toEqual([]);

      // A checkout added behind the cache's back stays invisible…
      runGit(source, ["worktree", "add", "-b", "review-branch", review]);
      expect(await externalWorktrees(input)).toEqual([]);

      // …until the watcher signal drops the entry.
      invalidateExternalWorktrees(input.projectEncoded);
      expect((await externalWorktrees(input)).map((w) => w.name)).toEqual([
        "review-branch",
      ]);

      // A changed exclusion set outranks the cache with no invalidation.
      expect(
        await externalWorktrees({ ...input, manualRoots: [source, review] }),
      ).toEqual([]);
    } finally {
      invalidateExternalWorktrees();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
