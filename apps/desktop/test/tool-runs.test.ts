import { describe, expect, it } from "vitest";
import {
  findToolRuns,
  RUN_PEEK_ROWS,
} from "@/renderer/features/chat/transcript/tool-runs";
import type { ConversationMessage, MessagePart } from "@/common/shared-types";

let seq = 0;
const msg = (
  role: "user" | "assistant",
  parts: MessagePart[],
): ConversationMessage => ({
  uuid: `m${seq++}`,
  parentUuid: null,
  parentMessageUuid: null,
  role,
  timestamp: "2026-09-02T10:00:00.000Z",
  parts,
});

const prompt = (text: string) => msg("user", [{ kind: "text", text }]);
const say = (text: string) => msg("assistant", [{ kind: "text", text }]);
const think = (text: string) => msg("assistant", [{ kind: "thinking", text }]);
const tool = (name: string, input: Record<string, unknown> = {}) =>
  msg("assistant", [{ kind: "tool_use", id: `t${seq++}`, tool: name, input }]);

const read = (file: string) => tool("Read", { file_path: file });
const ran = (command: string) => tool("Bash", { command });

const never = () => false;

describe("findToolRuns", () => {
  it("folds a run of tool rows and names what it did", () => {
    const items = [
      prompt("go"),
      read("a.ts"),
      read("b.ts"),
      ran("ls"),
      say("done"),
    ];
    const { runs, runOfRow } = findToolRuns(items, never);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      start: 1,
      end: 3,
      label: "Read files, ran commands",
    });
    expect(Array.from(runOfRow)).toEqual([-1, 0, 0, 0, -1]);
  });

  it("keeps prose out of the fold, and lets it split a run", () => {
    const items = [read("a.ts"), read("b.ts"), say("here it is"), read("c.ts")];
    const { runs } = findToolRuns(items, never);
    expect(runs).toHaveLength(0);
  });

  it("pulls the thinking between tool calls into the run", () => {
    const items = [think("hmm"), read("a.ts"), think("ok"), ran("ls")];
    const { runs } = findToolRuns(items, never);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, end: 3 });
    expect(runs[0].label).toBe("Thought, read files, ran commands");
  });

  it("leaves a thinking-only stretch alone — its rows already preview themselves", () => {
    const { runs } = findToolRuns([think("a"), think("b"), think("c")], never);
    expect(runs).toHaveLength(0);
  });

  it("leaves a short run inline", () => {
    const { runs } = findToolRuns([read("a.ts"), read("b.ts")], never);
    expect(runs).toHaveLength(0);
  });

  it("breaks the run on a part that renders as its own card", () => {
    const items = [
      read("a.ts"),
      read("b.ts"),
      tool("ExitPlanMode"),
      read("c.ts"),
    ];
    const isCard = (m: ConversationMessage) =>
      m.parts.some((p) => p.kind === "tool_use" && p.tool === "ExitPlanMode");
    const { runs } = findToolRuns(items, isCard);
    expect(runs).toHaveLength(0);
  });

  it("caps the peek at RUN_PEEK_ROWS so the rest can hide behind Show more", () => {
    const items = Array.from({ length: RUN_PEEK_ROWS + 5 }, (_, i) =>
      read(`f${i}.ts`),
    );
    const { runs } = findToolRuns(items, never);
    expect(runs[0].start).toBe(0);
    expect(runs[0].end).toBe(RUN_PEEK_ROWS + 4);
    expect(runs[0].peekEnd).toBe(RUN_PEEK_ROWS - 1);
  });

  it("names an unknown tool rather than inventing a phrase for it", () => {
    const { runs } = findToolRuns(
      [tool("Frobnicate"), tool("mcp__linear__list"), read("a.ts")],
      never,
    );
    expect(runs[0].label).toBe("Used Frobnicate, called MCP tools, read files");
  });

  it("keys a run by its first message so it survives an append", () => {
    const items = [prompt("go"), read("a.ts"), read("b.ts"), ran("ls")];
    const first = findToolRuns(items, never).runs[0];
    const grown = findToolRuns([...items, read("c.ts")], never).runs[0];
    expect(grown.key).toBe(first.key);
    expect(grown.end).toBe(4);
  });
});
