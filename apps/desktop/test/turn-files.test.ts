import { describe, expect, it } from "vitest";
import { turnFileChangesByRow } from "@/renderer/features/chat/transcript/turn-files";
import type { ConversationMessage, MessagePart } from "@/common/shared-types";

let seq = 0;
const msg = (
  role: "user" | "assistant",
  parts: MessagePart[],
  extra: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  uuid: `m${seq++}`,
  parentUuid: null,
  parentMessageUuid: null,
  role,
  timestamp: "2026-08-08T10:00:00.000Z",
  parts,
  ...extra,
});

const prompt = (text: string) =>
  msg("user", [{ kind: "text", text }], { promptSource: "typed" });

const say = (text: string) => msg("assistant", [{ kind: "text", text }]);

const edit = (path: string, oldText: string, newText: string) =>
  msg("assistant", [
    {
      kind: "tool_use",
      id: `t${seq++}`,
      tool: "Edit",
      input: { file_path: path, old_string: oldText, new_string: newText },
    },
  ]);

const write = (path: string, content: string) =>
  msg("assistant", [
    {
      kind: "tool_use",
      id: `t${seq++}`,
      tool: "Write",
      input: { file_path: path, content },
    },
  ]);

describe("turnFileChangesByRow", () => {
  it("folds every file a turn wrote into one strip on the turn's last row", () => {
    const items = [
      prompt("do it"),
      say("on it"),
      edit("/p/a.ts", "one\n", "ONE\n"),
      edit("/p/b.ts", "two\n", "TWO\n"),
      say("done"),
    ];

    const byRow = turnFileChangesByRow(items);

    expect([...byRow.keys()]).toEqual([4]);
    expect(byRow.get(4)!.map((f) => f.path)).toEqual(["/p/a.ts", "/p/b.ts"]);
  });

  it("merges repeat edits of one file and sums their line counts", () => {
    const items = [
      prompt("do it"),
      edit("/p/a.ts", "one\n", "ONE\n"),
      edit("/p/a.ts", "two\nthree\n", "TWO\n"),
    ];

    const files = turnFileChangesByRow(items).get(2)!;

    expect(files).toHaveLength(1);
    expect(files[0].lastOp - files[0].firstOp + 1).toBe(2);
    expect(files[0].added).toBe(2);
    expect(files[0].removed).toBe(3);
  });

  it("counts a Write as an all-added file", () => {
    const files = turnFileChangesByRow([
      prompt("make it"),
      write("/p/new.ts", "a\nb\nc\n"),
    ]).get(1)!;

    expect(files[0].added).toBe(3);
    expect(files[0].removed).toBe(0);
    expect(files[0].ops[files[0].firstOp]).toMatchObject({
      kind: "write",
      content: "a\nb\nc\n",
    });
  });

  it("keeps turns separate and leaves file-less turns out", () => {
    const items = [
      prompt("first"),
      edit("/p/a.ts", "one\n", "ONE\n"),
      prompt("second"),
      say("just answering"),
      prompt("third"),
      edit("/p/b.ts", "two\n", "TWO\n"),
      say("done"),
    ];

    const byRow = turnFileChangesByRow(items);

    expect([...byRow.keys()]).toEqual([1, 6]);
    expect(byRow.get(6)!.map((f) => f.path)).toEqual(["/p/b.ts"]);
  });

  it("ignores plan-file writes — the plan card owns those", () => {
    const items = [
      prompt("plan it"),
      write("/Users/x/.claude/plans/thing.md", "# Plan\n"),
      say("here's the plan"),
    ];

    expect(turnFileChangesByRow(items).size).toBe(0);
  });
});
