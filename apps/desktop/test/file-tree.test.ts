import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  buildFileTree,
  flattenFileTree,
} from "@/renderer/features/files/file-tree";

const id = (s: string) => s;

function labels(rows: ReturnType<typeof flattenFileTree<string>>) {
  return rows.map((r) =>
    r.kind === "dir"
      ? `${"  ".repeat(r.depth)}${r.dir.name}/`
      : `${"  ".repeat(r.depth)}${r.file}`,
  );
}

describe("buildFileTree + flattenFileTree", () => {
  it("builds dirs-first, name-sorted rows with depths", () => {
    const tree = buildFileTree(
      ["b.ts", "src/z.ts", "src/a.ts", "docs/readme.md", "a.ts"],
      id,
    );
    expect(labels(flattenFileTree(tree, () => true))).toEqual([
      "docs/",
      "  docs/readme.md",
      "src/",
      "  src/a.ts",
      "  src/z.ts",
      "a.ts",
      "b.ts",
    ]);
  });

  it("closed dirs are emitted but their contents are hidden", () => {
    const tree = buildFileTree(["src/a.ts", "src/deep/b.ts", "top.ts"], id);
    const rows = flattenFileTree(tree, () => false);
    expect(labels(rows)).toEqual(["src/", "top.ts"]);
  });

  it("isOpen gates per-directory (open src, keep src/deep closed)", () => {
    const tree = buildFileTree(["src/a.ts", "src/deep/b.ts"], id);
    const rows = flattenFileTree(tree, (p) => p === "src");
    expect(labels(rows)).toEqual(["src/", "  deep/", "  src/a.ts"]);
  });

  it("compacts single-child chains into one node keyed by the deepest path", () => {
    const tree = buildFileTree(["a/b/c/file.ts", "a/b/c/other.ts"], id, {
      compact: true,
    });
    const rows = flattenFileTree(tree, () => true);
    expect(rows[0]).toMatchObject({
      kind: "dir",
      depth: 0,
      dir: { name: "a/b/c", path: "a/b/c" },
    });
    expect(labels(rows)).toEqual([
      "a/b/c/",
      "  a/b/c/file.ts",
      "  a/b/c/other.ts",
    ]);
  });

  it("does not compact through a dir that has files of its own", () => {
    const tree = buildFileTree(["a/b/keep.ts", "a/b/c/file.ts"], id, {
      compact: true,
    });
    expect(labels(flattenFileTree(tree, () => true))).toEqual([
      "a/b/",
      "  c/",
      "    a/b/c/file.ts",
      "  a/b/keep.ts",
    ]);
  });

  it("carries an arbitrary leaf payload via pathOf", () => {
    const files = [
      { path: "src/two.ts", letter: "M" },
      { path: "one.ts", letter: "A" },
    ];
    const tree = buildFileTree(files, (f) => f.path);
    const rows = flattenFileTree(tree, () => true);
    const fileRows = rows.filter((r) => r.kind === "file");
    expect(fileRows.map((r) => r.kind === "file" && r.file.letter)).toEqual([
      "M",
      "A",
    ]);
  });

  it("empty input yields an empty flatten", () => {
    expect(flattenFileTree(buildFileTree([], id), () => true)).toEqual([]);
  });
});

describe("ancestorDirs", () => {
  it("lists every ancestor of a nested path", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
  });
  it("a root-level file has none", () => {
    expect(ancestorDirs("c.ts")).toEqual([]);
  });
});
