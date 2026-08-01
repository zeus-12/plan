import { describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@/main/providers/claude-code/transcript";
import { abortedPromptUuids } from "@/renderer/features/chat/transcript/message-kind";
import type { ParsedSession } from "@/common/shared-types";

// Shapes taken from real Claude Code transcripts: a submitted prompt is
// followed by `attachment` lines that chain off it, so the reply's parentUuid
// names the last attachment rather than the prompt itself.
const ts = (i: number) => `2026-07-29T11:34:${String(i).padStart(2, "0")}.000Z`;

const prompt = (
  uuid: string,
  parent: string | null,
  text: string,
  promptSource: string | null = "typed",
) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: parent,
    sessionId: "sess-1",
    cwd: "/Users/x/proj",
    timestamp: ts(1),
    ...(promptSource ? { promptSource } : {}),
    origin: { kind: "human" },
    message: { role: "user", content: text },
  }) + "\n";

const attachment = (uuid: string, parent: string) =>
  JSON.stringify({
    type: "attachment",
    uuid,
    parentUuid: parent,
    timestamp: ts(1),
    attachment: { type: "nested_memory", content: "…" },
  }) + "\n";

const reply = (uuid: string, parent: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: parent,
    sessionId: "sess-1",
    timestamp: ts(2),
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";

const toolUse = (uuid: string, parent: string, id: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid: parent,
    sessionId: "sess-1",
    timestamp: ts(3),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { cmd: "ls" } }],
    },
  }) + "\n";

const toolResult = (uuid: string, parent: string, id: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    parentUuid: parent,
    sessionId: "sess-1",
    timestamp: ts(4),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
  }) + "\n";

// A local Claude Code snapshot line: no uuid at all, so it must not disturb the
// chain the way an attachment does.
const snapshot = (messageId: string) =>
  JSON.stringify({
    type: "file-history-snapshot",
    messageId,
    snapshot: { messageId, trackedFileBackups: {} },
  }) + "\n";

const parse = (lines: string): ParsedSession =>
  parseSessionJsonl(lines, "/tmp/s.jsonl");

describe("parentMessageUuid", () => {
  it("collapses attachment chains so a reply points at its prompt", () => {
    const { messages } = parse(
      prompt("u1", null, "hi") +
        attachment("at1", "u1") +
        attachment("at2", "at1") +
        reply("a1", "at2", "hey"),
    );
    expect(messages.map((m) => m.uuid)).toEqual(["u1", "a1"]);
    expect(messages[0].parentMessageUuid).toBeNull();
    // Without the collapse this would be "at2", a line the transcript never
    // renders — the edge the abort check walks.
    expect(messages[1].parentMessageUuid).toBe("u1");
  });

  it("is unaffected by uuid-less lines between messages", () => {
    const { messages } = parse(
      snapshot("u1") +
        prompt("u1", null, "hi") +
        snapshot("a1") +
        reply("a1", "u1", "hey"),
    );
    expect(messages[1].parentMessageUuid).toBe("u1");
  });
});

describe("abortedPromptUuids", () => {
  it("flags a prompt that got no reply before the next prompt", () => {
    // Escape hit immediately: u1 is on disk, produced nothing, and u2 is the
    // retype that actually ran.
    const { messages } = parse(
      prompt("u1", null, "first") +
        attachment("at1", "u1") +
        prompt("u2", null, "second") +
        attachment("at2", "u2") +
        reply("a1", "at2", "on it"),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set(["u1"]));
  });

  it("flags a mid-conversation abandon, where the two prompts are siblings", () => {
    const { messages } = parse(
      prompt("u1", null, "one") +
        reply("a1", "u1", "done") +
        prompt("u2", "a1", "commit pls") +
        prompt("u3", "a1", "actually wait") +
        reply("a2", "u3", "holding"),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set(["u2"]));
  });

  it("never flags the newest submission, whose reply may be one tick away", () => {
    const { messages } = parse(
      prompt("u1", null, "one") +
        reply("a1", "u1", "done") +
        prompt("u2", "a1", "next"),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set());
  });

  it("spares the newest submission even with its own lines trailing it", () => {
    // The image line makes the prompt no longer the last message; without this
    // it would read as abandoned for the seconds before the reply lands.
    const { messages } = parse(
      prompt("u1", null, "one") +
        reply("a1", "u1", "done") +
        prompt("u2", "a1", "look at this") +
        prompt("img2", "u2", "[Image: source: /tmp/a.png]", null),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set());
  });

  it("leaves a run of unanswered prompts alone until one of them is answered", () => {
    // Two prompts queued behind a turn that's still running. Nothing after them
    // has been answered, so neither is provably abandoned — and this holds
    // without asking whether Claude is working, which a background tab can't
    // answer truthfully.
    const queued =
      prompt("u1", null, "one") +
      reply("a1", "u1", "working on it") +
      prompt("u2", "a1", "queued A") +
      prompt("u3", "a1", "queued B");
    expect(abortedPromptUuids(parse(queued).messages)).toEqual(new Set());
    // Once B is answered, A is settled: Claude moved past it.
    expect(
      abortedPromptUuids(parse(queued + reply("a2", "u3", "on B")).messages),
    ).toEqual(new Set(["u2"]));
  });

  it("counts a reply reached through tool turns, and ignores tool results", () => {
    const { messages } = parse(
      prompt("u1", null, "run it") +
        toolUse("a1", "u1", "t1") +
        toolResult("r1", "a1", "t1") +
        reply("a2", "r1", "done") +
        prompt("u2", "a2", "thanks"),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set());
  });

  it("leaves alone the user-role lines that aren't submissions", () => {
    // All three of these sit unanswered in real transcripts and would read as
    // abandoned prompts on structure alone: a locally-executed command, the
    // interrupt marker Claude writes after a mid-reply Esc, and a queued prompt
    // dropped by that same interrupt. Only the last one was ever submitted.
    const { messages } = parse(
      prompt("u1", null, "one") +
        reply("a1", "u1", "starting") +
        prompt("c1", "a1", "/compact", null) +
        prompt("m1", "a1", "[Request interrupted by user]", null) +
        prompt("q1", "m1", "queued and dropped", "queued") +
        prompt("u2", "m1", "two") +
        reply("a2", "u2", "done"),
    );
    expect(abortedPromptUuids(messages)).toEqual(new Set(["q1"]));
  });

  it("dims a pasted screenshot's image line with the prompt it belongs to", () => {
    // Claude writes the "[Image: source: …]" line as its own message hanging off
    // the prompt, and it carries no promptSource of its own.
    const lines =
      prompt("u1", null, "look at this") +
      prompt("img1", "u1", "[Image: source: /tmp/a.png]", null) +
      prompt("u2", null, "look at this (again)") +
      prompt("img2", "u2", "[Image: source: /tmp/a.png]", null) +
      reply("a1", "img2", "I see it");
    expect(abortedPromptUuids(parse(lines).messages)).toEqual(
      new Set(["u1", "img1"]),
    );
    // The image line inherits its parent's verdict regardless of position — as
    // the newest message it would otherwise sit undimmed under a dimmed prompt.
    const trailing =
      prompt("u1", null, "look at this") +
      prompt("img1", "u1", "[Image: source: /tmp/a.png]", null) +
      prompt("u2", null, "look at this (again)") +
      reply("a1", "u2", "I see it") +
      prompt("u3", "a1", "and this") +
      prompt("img3", "u3", "[Image: source: /tmp/b.png]", null) +
      prompt("u4", "a1", "no wait, this") +
      reply("a2", "u4", "on it");
    expect(abortedPromptUuids(parse(trailing).messages)).toEqual(
      new Set(["u1", "img1", "u3", "img3"]),
    );
  });

  it("claims nothing when the tree resolved to nothing", () => {
    // Parent links lost (e.g. a provider that doesn't populate them): reading
    // every prompt as abandoned would dim the whole transcript.
    const messages = parse(
      prompt("u1", null, "one") + prompt("u2", null, "two"),
    ).messages.map((m) => ({ ...m, parentMessageUuid: null }));
    expect(abortedPromptUuids(messages)).toEqual(new Set());
  });
});
