import { describe, expect, it } from "vitest";
import { createTwoFilesPatch } from "diff";
import { reconstructOldText } from "../../../shared/lib/diff-reconstruct";
import { parseUnifiedDiff } from "../../../shared/lib/diff-parser";
import {
  buildSingleHunkPatch,
  findHunkIndexForRange,
  parseFileDiff,
} from "../../../shared/lib/git-hunks";
import {
  buildDiffLines,
  buildSplitRows,
  diffAnchorLines,
  diffAnchorMatches,
  filterUnchangedLines,
  getDiffLineForOffset,
  type Separator,
} from "../../../shared/lib/diff";
import {
  applyChangeLeftToRight,
  applyChangeRightToLeft,
  computeChanges,
} from "../../../shared/lib/diff-merge";

/** A realistic unified diff for one file, in the shape `gh pr diff` emits. */
function diffOf(oldText: string, newText: string): string {
  return createTwoFilesPatch("a/file.ts", "b/file.ts", oldText, newText);
}

// ── reconstructOldText ───────────────────────────────────────────────
// The old side is fully determined by (new text, diff); reconstructing it and
// comparing against the real old text is the strongest possible check, so
// these are round-trip properties over the newline/edit-position cases that
// the implementation's cursor and terminator logic have to get right.

describe("reconstructOldText", () => {
  const roundTrip = (oldText: string, newText: string) => {
    expect(reconstructOldText(newText, diffOf(oldText, newText))).toBe(oldText);
  };

  it("reconstructs a middle edit", () => {
    roundTrip("a\nb\nc\nd\ne\n", "a\nb\nCHANGED\nd\ne\n");
  });

  it("reconstructs edits at the first and last line", () => {
    roundTrip("first\nb\nc\n", "FIRST\nb\nc\n");
    roundTrip("a\nb\nlast\n", "a\nb\nLAST\n");
  });

  it("reconstructs pure insertions and deletions", () => {
    roundTrip("a\nb\n", "a\nx\ny\nb\n");
    roundTrip("a\nx\ny\nb\n", "a\nb\n");
  });

  it("reconstructs multi-hunk diffs with unchanged gaps", () => {
    const oldText =
      Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n") + "\n";
    const newText = oldText
      .replace("line3", "LINE3")
      .replace("line25", "LINE25");
    roundTrip(oldText, newText);
  });

  it("handles the old side lacking a trailing newline", () => {
    roundTrip("a\nb\nno-eol", "a\nb\nchanged\n");
  });

  it("handles the new side lacking a trailing newline", () => {
    roundTrip("a\nb\nold\n", "a\nb\nno-eol");
  });

  it("handles neither side having a trailing newline", () => {
    roundTrip("a\nold", "a\nnew");
  });

  it("reconstructs a fully added file (old side empty)", () => {
    roundTrip("", "a\nb\n");
  });

  it("reconstructs a fully deleted file (new side empty)", () => {
    roundTrip("a\nb\n", "");
  });

  it("returns the new text unchanged when the diff has no hunks (rename)", () => {
    const body = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    expect(reconstructOldText("same\ncontent\n", body)).toBe("same\ncontent\n");
  });

  it("preserves blank context lines (prefixed ' ', not '')", () => {
    roundTrip("a\n\nb\nold\n", "a\n\nb\nnew\n");
  });
});

// ── parseUnifiedDiff ─────────────────────────────────────────────────

const MULTI_FILE_DIFF = [
  "diff --git a/src/mod.ts b/src/mod.ts",
  "index 111..222 100644",
  "--- a/src/mod.ts",
  "+++ b/src/mod.ts",
  "@@ -1,3 +1,3 @@",
  " context",
  "-removed line",
  "+added line",
  " context",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 444..000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "diff --git a/src/before.ts b/src/after.ts",
  "similarity index 90%",
  "rename from src/before.ts",
  "rename to src/after.ts",
  "--- a/src/before.ts",
  "+++ b/src/after.ts",
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
  "diff --git a/img.png b/img.png",
  "index 555..666 100644",
  "Binary files a/img.png and b/img.png differ",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("splits files and classifies statuses", () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/mod.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/gone.ts", "deleted"],
      ["src/after.ts", "renamed"],
      ["img.png", "modified"],
    ]);
  });

  it("resolves old/new paths per status", () => {
    const [mod, added, deleted, renamed] = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(mod.oldPath).toBe("src/mod.ts");
    expect(added.oldPath).toBeNull();
    expect(added.newPath).toBe("src/new.ts");
    expect(deleted.newPath).toBeNull();
    expect(deleted.path).toBe("src/gone.ts");
    expect(renamed.oldPath).toBe("src/before.ts");
    expect(renamed.newPath).toBe("src/after.ts");
  });

  it("counts additions/deletions from hunk lines only", () => {
    const [mod, added, deleted] = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect([mod.additions, mod.deletions]).toEqual([1, 1]);
    expect([added.additions, added.deletions]).toEqual([2, 0]);
    expect([deleted.additions, deleted.deletions]).toEqual([0, 1]);
  });

  it("flags binary files and gives them zero counts", () => {
    const binary = parseUnifiedDiff(MULTI_FILE_DIFF).at(-1)!;
    expect(binary.binary).toBe(true);
    expect([binary.additions, binary.deletions]).toEqual([0, 0]);
  });

  it("returns [] for empty or whitespace input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("  \n ")).toEqual([]);
  });
});

// ── parseFileDiff + buildSingleHunkPatch ─────────────────────────────

const TWO_HUNK_BODY = [
  "diff --git a/f.ts b/f.ts",
  "index 111..222 100644",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -10,2 +10,3 @@",
  " x",
  "+inserted",
  " y",
].join("\n");

describe("parseFileDiff", () => {
  it("separates the file header from hunks", () => {
    const parsed = parseFileDiff(TWO_HUNK_BODY);
    expect(parsed.fileHeader).toBe(
      "diff --git a/f.ts b/f.ts\nindex 111..222 100644\n--- a/f.ts\n+++ b/f.ts",
    );
    expect(parsed.hunks).toHaveLength(2);
  });

  it("parses hunk coordinates, defaulting omitted counts to 1", () => {
    const [h1, h2] = parseFileDiff(TWO_HUNK_BODY).hunks;
    expect([h1.oldStart, h1.oldCount, h1.newStart, h1.newCount]).toEqual([
      1, 3, 1, 3,
    ]);
    expect([h2.oldStart, h2.oldCount, h2.newStart, h2.newCount]).toEqual([
      10, 2, 10, 3,
    ]);
    const single = parseFileDiff("--- a/f\n+++ b/f\n@@ -5 +5 @@\n-x\n+y")
      .hunks[0];
    expect([single.oldCount, single.newCount]).toEqual([1, 1]);
  });

  it("counts per-hunk additions/deletions", () => {
    const [h1, h2] = parseFileDiff(TWO_HUNK_BODY).hunks;
    expect([h1.additions, h1.deletions]).toEqual([1, 1]);
    expect([h2.additions, h2.deletions]).toEqual([1, 0]);
  });

  it("yields no hunks for a hunkless body (rename/binary)", () => {
    const parsed = parseFileDiff("diff --git a/x b/y\nrename from x");
    expect(parsed.hunks).toEqual([]);
  });
});

describe("buildSingleHunkPatch", () => {
  it("reassembles header + one hunk with a trailing newline", () => {
    const parsed = parseFileDiff(TWO_HUNK_BODY);
    const patch = buildSingleHunkPatch(parsed, 1);
    expect(patch).toBe(
      parsed.fileHeader + "\n@@ -10,2 +10,3 @@\n x\n+inserted\n y\n",
    );
  });

  it("throws on a missing hunk index", () => {
    const parsed = parseFileDiff(TWO_HUNK_BODY);
    expect(() => buildSingleHunkPatch(parsed, 5)).toThrow();
  });
});

describe("findHunkIndexForRange", () => {
  const { hunks } = parseFileDiff(TWO_HUNK_BODY); // @@ -1,3 +1,3 @@ and @@ -10,2 +10,3 @@

  it("matches by new-side overlap (an insertion has no old span)", () => {
    expect(
      findHunkIndexForRange(hunks, {
        oldStart: null,
        oldEnd: null,
        newStart: 11,
        newEnd: 11,
      }),
    ).toBe(1);
  });

  it("matches by old-side overlap (a deletion has no new span)", () => {
    expect(
      findHunkIndexForRange(hunks, {
        oldStart: 2,
        oldEnd: 2,
        newStart: null,
        newEnd: null,
      }),
    ).toBe(0);
  });

  it("returns -1 when nothing overlaps", () => {
    expect(
      findHunkIndexForRange(hunks, {
        oldStart: 100,
        oldEnd: 120,
        newStart: 100,
        newEnd: 120,
      }),
    ).toBe(-1);
  });
});

// ── buildDiffLines and friends (the renderer's in-JS re-diff) ────────

describe("buildDiffLines", () => {
  it("numbers old/new sides independently", () => {
    const lines = buildDiffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(lines.map((l) => [l.type, l.content, l.oldNum, l.newNum])).toEqual([
      ["context", "a", 1, 1],
      ["remove", "b", 2, undefined],
      ["add", "B", undefined, 2],
      ["context", "c", 3, 3],
    ]);
  });

  it("computes word segments on paired remove/add lines", () => {
    const [remove, add] = buildDiffLines("const x = 1;\n", "const x = 2;\n");
    expect(remove.wordSegments!.some((s) => s.changed && s.text === "1")).toBe(
      true,
    );
    expect(add.wordSegments!.some((s) => s.changed && s.text === "2")).toBe(
      true,
    );
  });

  it("marks whitespace-only changes when ignoring whitespace", () => {
    const lines = buildDiffLines("  a\n", "a\n", true);
    expect(lines.every((l) => l.whitespaceOnly)).toBe(true);
  });
});

describe("filterUnchangedLines", () => {
  it("collapses far-away context into separators with exact hidden counts", () => {
    const oldText =
      Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
    const newText = oldText.replace("l10", "L10");
    const items = filterUnchangedLines(buildDiffLines(oldText, newText), 3);
    const seps = items.filter((x): x is Separator => x.type === "separator");
    // 20 content lines become 21 diff lines (remove@10 + add@11). Visible:
    // idx 7..14 (3 context each side). Hidden: 0..6 (7) and 15..20 (6).
    expect(seps.map((s) => s.hiddenCount)).toEqual([7, 6]);
    const visible = items.filter((x) => x.type !== "separator");
    expect(visible).toHaveLength(8); // 3 + remove + add + 3
  });

  it("returns one separator covering everything when nothing changed", () => {
    const items = filterUnchangedLines(buildDiffLines("a\nb\n", "a\nb\n"));
    expect(items).toEqual([{ type: "separator", hiddenCount: 2 }]);
  });
});

describe("buildSplitRows", () => {
  it("pairs removes with adds and pads the shorter side", () => {
    const rows = buildSplitRows(buildDiffLines("a\nb\nc\n", "a\nX\n"));
    const pairs = rows.filter((r) => r.type === "pair");
    // context a | a, then b|X, c|(empty)
    expect(pairs).toHaveLength(3);
    const [, p2, p3] = pairs as Extract<
      (typeof rows)[number],
      { type: "pair" }
    >[];
    expect([p2.left?.content, p2.right?.content]).toEqual(["b", "X"]);
    expect([p3.left?.content, p3.right]).toEqual(["c", undefined]);
  });
});

describe("getDiffLineForOffset", () => {
  it("maps flat text offsets back to line indexes", () => {
    const lines = buildDiffLines("aa\nbb\n", "aa\nbb\ncc\n");
    // "aa\n" spans offsets 0..2, "bb\n" 3..5, "cc\n" 6..8
    expect(getDiffLineForOffset(0, lines)).toBe(0);
    expect(getDiffLineForOffset(4, lines)).toBe(1);
    expect(getDiffLineForOffset(7, lines)).toBe(2);
    expect(getDiffLineForOffset(999, lines)).toBe(lines.length - 1);
  });
});

// ── diff-merge (the per-change accept/revert text splicing) ──────────

describe("diff-merge", () => {
  const merge = (oldText: string, newText: string) => {
    const lines = buildDiffLines(oldText, newText);
    return { lines, changes: computeChanges(lines) };
  };

  it("groups consecutive non-context lines into one change", () => {
    const { changes } = merge("a\nb\nc\n", "a\nB\nC\n");
    expect(changes).toHaveLength(1);
    expect(changes[0].removed.map((l) => l.content)).toEqual(["b", "c"]);
    expect(changes[0].added.map((l) => l.content)).toEqual(["B", "C"]);
  });

  it("accept-right replaces the old lines in the left text", () => {
    const { lines, changes } = merge("a\nb\nc\n", "a\nB\nc\n");
    expect(applyChangeRightToLeft("a\nb\nc\n", changes[0], lines)).toBe(
      "a\nB\nc\n",
    );
  });

  it("accept-right splices a pure insertion into the left text", () => {
    const { lines, changes } = merge("a\nc\n", "a\nb\nc\n");
    expect(applyChangeRightToLeft("a\nc\n", changes[0], lines)).toBe(
      "a\nb\nc\n",
    );
  });

  it("revert-to-left restores removed lines in the right text", () => {
    const { lines, changes } = merge("a\nb\nc\n", "a\nc\n");
    expect(applyChangeLeftToRight("a\nc\n", changes[0], lines)).toBe(
      "a\nb\nc\n",
    );
  });

  it("handles a change at the very first line (no preceding context)", () => {
    const { lines, changes } = merge("x\na\n", "a\n");
    expect(applyChangeLeftToRight("a\n", changes[0], lines)).toBe("x\na\n");
  });
});

// ── Comment anchors ──────────────────────────────────────────────────
// Comment offsets index the flat diff text (all diff lines, both sides, in
// render order) — NOT the old/new file text. Applying them to the file text
// instead used to make every comment on a changed line look stale, so it was
// deleted the instant it was created.

describe("diff comment anchors", () => {
  const oldText = "a\nb\nc\n";
  const newText = "a\nB\nc\n";
  const dLines = buildDiffLines(oldText, newText);
  /** The flat offsets of `content` within the diff lines. */
  function anchorOf(content: string, side: "left" | "right") {
    const line = dLines.find((l) => l.content === content)!;
    return {
      startOffset: line.flatOffset,
      endOffset: line.flatOffset + line.content.length,
      side,
    };
  }

  it("keeps a comment on a changed line anchored", () => {
    const anchor = anchorOf("B", "right");
    // Guards the regression directly: these offsets do NOT locate "B" in the
    // new file text, only in the flat diff text.
    expect(newText.slice(anchor.startOffset, anchor.endOffset)).not.toBe("B");
    expect(diffAnchorMatches(dLines, anchor, "B")).toBe(true);
  });

  it("keeps a comment on a removed line anchored", () => {
    expect(diffAnchorMatches(dLines, anchorOf("b", "left"), "b")).toBe(true);
  });

  it("keeps a multi-line split-view selection anchored (other side's rows fall between)", () => {
    const start = dLines.find((l) => l.content === "B")!;
    const end = dLines.find((l) => l.content === "c")!;
    const anchor = {
      startOffset: start.flatOffset,
      endOffset: end.flatOffset + end.content.length,
      side: "right" as const,
    };
    expect(diffAnchorMatches(dLines, anchor, "B\nc")).toBe(true);
  });

  it("drops a comment once the line it covers changed", () => {
    const anchor = anchorOf("B", "right");
    const moved = buildDiffLines(oldText, "a\nZZZ\nc\n");
    expect(diffAnchorMatches(moved, anchor, "B")).toBe(false);
  });

  it("drops a comment whose offsets fall outside the diff", () => {
    expect(
      diffAnchorMatches(
        dLines,
        { startOffset: 900, endOffset: 999, side: "right" },
        "B",
      ),
    ).toBe(false);
  });

  it("reports the file line numbers of the side the comment is on", () => {
    expect(diffAnchorLines(dLines, anchorOf("B", "right"))).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(diffAnchorLines(dLines, anchorOf("b", "left"))).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it("narrows a range to the lines the side actually numbers", () => {
    // Whole diff selected on the right: the removed "b" row has no new-file
    // number, so the range reports the added/context lines around it.
    const last = dLines.at(-1)!;
    expect(
      diffAnchorLines(dLines, {
        startOffset: 0,
        endOffset: last.flatOffset + last.content.length,
        side: "right",
      }),
    ).toEqual({ startLine: 1, endLine: 3 });
  });
});
