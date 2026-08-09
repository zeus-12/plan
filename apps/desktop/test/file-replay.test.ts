import { describe, expect, it } from "vitest";
import {
  applyForward,
  applyReverse,
  textAfterOp,
  type FileOp,
} from "@/renderer/features/chat/transcript/file-replay";

const edit = (
  oldText: string,
  newText: string,
  replaceAll = false,
  row = 0,
): FileOp => ({ kind: "edit", row, oldText, newText, replaceAll });

const write = (content: string, row = 0): FileOp => ({
  kind: "write",
  row,
  content,
});

describe("applyForward", () => {
  it("replaces the first occurrence, like the Edit tool", () => {
    expect(applyForward("a\nb\na\n", edit("a", "X"))).toBe("X\nb\na\n");
  });

  it("replaces every occurrence when replace_all was set", () => {
    expect(applyForward("a\nb\na\n", edit("a", "X", true))).toBe("X\nb\nX\n");
  });

  it("fails when the target text isn't there", () => {
    expect(applyForward("a\n", edit("zzz", "X"))).toBeNull();
  });
});

describe("applyReverse", () => {
  it("puts the old text back", () => {
    expect(applyReverse("X\nb\n", edit("a", "X"))).toBe("a\nb\n");
  });

  it("refuses when the result appears more than once — nothing says which one", () => {
    expect(applyReverse("X\nb\nX\n", edit("a", "X"))).toBeNull();
  });

  it("refuses when the text is gone (someone else edited the file)", () => {
    expect(applyReverse("totally different\n", edit("a", "X"))).toBeNull();
  });

  it("refuses to undo a Write — what it overwrote is unknowable", () => {
    expect(applyReverse("anything", write("anything"))).toBeNull();
  });

  it("refuses a pure deletion — an empty needle matches everywhere", () => {
    expect(applyReverse("a\n", edit("gone\n", ""))).toBeNull();
  });
});

describe("textAfterOp", () => {
  it("replays forward from a Write checkpoint, ignoring disk entirely", () => {
    const ops = [write("one\ntwo\n"), edit("two", "TWO")];
    expect(textAfterOp(ops, 1, "whatever is on disk")).toBe("one\nTWO\n");
    expect(textAfterOp(ops, 0, "whatever is on disk")).toBe("one\ntwo\n");
  });

  it("peels later edits off the disk text when there's no checkpoint", () => {
    const ops = [edit("one", "ONE"), edit("two", "TWO")];
    const disk = "ONE\nTWO\nthree\n";

    expect(textAfterOp(ops, 1, disk)).toBe(disk);
    expect(textAfterOp(ops, 0, disk)).toBe("ONE\ntwo\nthree\n");
    expect(textAfterOp(ops, -1, disk)).toBe("one\ntwo\nthree\n");
  });

  it("peels back through many later edits — depth is not the problem", () => {
    const ops = Array.from({ length: 20 }, (_, i) =>
      edit(`line${i}`, `LINE${i}`, false, i),
    );
    let disk = "";
    for (let i = 0; i < 20; i++) disk += `LINE${i}\n`;

    // The state right after the 5th edit: edits 0–4 applied, 5–19 not.
    const at5 = textAfterOp(ops, 4, disk);
    expect(at5).toBe(
      Array.from({ length: 20 }, (_, i) =>
        i < 5 ? `LINE${i}\n` : `line${i}\n`,
      ).join(""),
    );
  });

  it("gives up when the file was changed outside the session", () => {
    const ops = [edit("one", "ONE"), edit("two", "TWO")];
    // Someone (another chat, an editor) reverted TWO back by hand.
    expect(textAfterOp(ops, 0, "ONE\nsomething else\n")).toBeNull();
  });

  it("gives up rather than peel back past a later Write", () => {
    const ops = [edit("one", "ONE"), write("rewritten\n", 1)];
    expect(textAfterOp(ops, 0, "rewritten\n")).toBeNull();
  });

  it("still reconstructs the newer turn when an older one is unreachable", () => {
    const ops = [
      edit("one", "ONE"),
      write("a\nb\n", 1),
      edit("b", "B", false, 2),
    ];
    const disk = "a\nB\n";

    expect(textAfterOp(ops, 2, disk)).toBe("a\nB\n");
    expect(textAfterOp(ops, 1, disk)).toBe("a\nb\n");
    expect(textAfterOp(ops, 0, disk)).toBeNull();
  });
});
