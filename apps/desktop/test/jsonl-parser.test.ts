import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSessionJsonl,
  readSessionDelta,
  readSessionMeta,
} from "../src/main/jsonl-parser";

// The incremental reader keeps module-level per-file state, so every test uses
// its own file path.
const dir = mkdtempSync(join(tmpdir(), "plan-jsonl-"));
let n = 0;
const freshFile = () => join(dir, `s-${++n}.jsonl`);

const ts = (i: number) => `2026-07-11T10:00:${String(i).padStart(2, "0")}.000Z`;

const userLine = (i: number, text: string) =>
  JSON.stringify({
    type: "user",
    uuid: `u-${i}`,
    parentUuid: null,
    sessionId: "sess-1",
    cwd: "/Users/x/proj",
    timestamp: ts(i),
    message: { content: text },
  }) + "\n";

const assistantLine = (i: number, content: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a-${i}`,
    parentUuid: `u-${i - 1}`,
    sessionId: "sess-1",
    timestamp: ts(i),
    message: { content },
  }) + "\n";

describe("readSessionDelta", () => {
  it("incremental appends assemble the same session as a full parse", async () => {
    const file = freshFile();
    const chunks = [
      userLine(1, "héllo 🎉 start"),
      assistantLine(2, [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "yes — é" },
      ]),
      userLine(3, "next"),
      assistantLine(4, [
        { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
      ]),
    ];

    await writeFile(file, chunks[0]);
    let res = await readSessionDelta(file);
    expect(res.mode).toBe("full");
    let assembled = res.messages;
    let cursor = { gen: res.gen, have: assembled.length };

    for (const chunk of chunks.slice(1)) {
      // Split each append mid-chunk so a read can land inside a line (and
      // inside the multibyte chars above).
      const buf = Buffer.from(chunk, "utf-8");
      const mid = Math.floor(buf.length / 2);
      await appendFile(file, buf.subarray(0, mid));
      res = await readSessionDelta(file, cursor);
      expect(res.mode).toBe("append");
      assembled = assembled.concat(res.messages);
      cursor = { gen: res.gen, have: assembled.length };

      await appendFile(file, buf.subarray(mid));
      res = await readSessionDelta(file, cursor);
      expect(res.mode).toBe("append");
      assembled = assembled.concat(res.messages);
      cursor = { gen: res.gen, have: assembled.length };
    }

    const full = parseSessionJsonl(await readFile(file, "utf-8"), file);
    expect(assembled).toEqual(full.messages);
    expect(res.meta).toEqual(full.meta);
    expect(res.total).toBe(full.messages.length);
  });

  it("append mode returns only the new messages under a stable gen", async () => {
    const file = freshFile();
    await writeFile(file, userLine(1, "one"));
    const first = await readSessionDelta(file);
    expect(first.mode).toBe("full");
    expect(first.messages).toHaveLength(1);

    await appendFile(file, assistantLine(2, [{ type: "text", text: "two" }]));
    const second = await readSessionDelta(file, {
      gen: first.gen,
      have: 1,
    });
    expect(second.gen).toBe(first.gen);
    expect(second.mode).toBe("append");
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].uuid).toBe("a-2");
    expect(second.total).toBe(2);
  });

  it("a stale gen gets a full restatement", async () => {
    const file = freshFile();
    await writeFile(file, userLine(1, "one") + userLine(2, "two"));
    const res = await readSessionDelta(file, { gen: 999_999, have: 1 });
    expect(res.mode).toBe("full");
    expect(res.messages).toHaveLength(2);
  });

  it("a rewritten tail resets the fold (streaming tool_use completion)", async () => {
    const file = freshFile();
    const partial = assistantLine(2, [
      { type: "tool_use", id: "t1", name: "ExitPlanMode", input: {} },
    ]);
    await writeFile(file, userLine(1, "go") + partial);
    const first = await readSessionDelta(file);
    expect(first.messages).toHaveLength(2);
    const toolPart = first.messages[1].parts[0];
    expect(toolPart.kind === "tool_use" && toolPart.input).toEqual({});

    // Claude truncates the partial line and rewrites it with the full input —
    // the file GROWS, so only the tail-overlap check can catch it.
    const complete = assistantLine(2, [
      {
        type: "tool_use",
        id: "t1",
        name: "ExitPlanMode",
        input: { plan: "the actual plan text" },
      },
    ]);
    await writeFile(file, userLine(1, "go") + complete);

    const second = await readSessionDelta(file, {
      gen: first.gen,
      have: first.messages.length,
    });
    expect(second.gen).not.toBe(first.gen);
    expect(second.mode).toBe("full");
    const rewritten = second.messages[1].parts[0];
    expect(rewritten.kind === "tool_use" && rewritten.input).toEqual({
      plan: "the actual plan text",
    });
  });

  it("a shrunken file resets the fold", async () => {
    const file = freshFile();
    await writeFile(file, userLine(1, "one") + userLine(2, "two"));
    const first = await readSessionDelta(file);
    expect(first.messages).toHaveLength(2);

    await writeFile(file, userLine(1, "one"));
    const second = await readSessionDelta(file, {
      gen: first.gen,
      have: 2,
    });
    expect(second.gen).not.toBe(first.gen);
    expect(second.mode).toBe("full");
    expect(second.messages).toHaveLength(1);
  });

  it("a trailing partial line is held back until its newline arrives", async () => {
    const file = freshFile();
    const line = userLine(1, "complete me");
    await writeFile(file, line.slice(0, 20)); // no newline yet
    const first = await readSessionDelta(file);
    expect(first.messages).toHaveLength(0);

    await appendFile(file, line.slice(20));
    const second = await readSessionDelta(file, {
      gen: first.gen,
      have: 0,
    });
    expect(second.mode).toBe("append");
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].uuid).toBe("u-1");
  });
});

describe("readSessionMeta", () => {
  it("tracks appends incrementally and matches the full parse", async () => {
    const file = freshFile();
    await writeFile(file, userLine(1, "one"));
    let meta = await readSessionMeta(file);
    expect(meta.messageCount).toBe(1);
    expect(meta.cwd).toBe("/Users/x/proj");

    await appendFile(
      file,
      assistantLine(2, [{ type: "text", text: "two" }]) + userLine(3, "three"),
    );
    meta = await readSessionMeta(file);
    const full = parseSessionJsonl(await readFile(file, "utf-8"), file);
    expect(meta.messageCount).toBe(full.meta.messageCount);
    expect(meta.updatedAt).toBe(full.meta.updatedAt);
    expect(meta.startedAt).toBe(full.meta.startedAt);
  });

  it("recovers exact counts after a same-or-larger-size rewrite", async () => {
    const file = freshFile();
    await writeFile(file, userLine(1, "one") + userLine(2, "two"));
    expect((await readSessionMeta(file)).messageCount).toBe(2);

    // Rewrite with different content but MORE bytes — the old shrink-only
    // check missed this; the tail-overlap check must catch it.
    await writeFile(
      file,
      userLine(1, "one") + userLine(2, "two, but rewritten longer"),
    );
    const meta = await readSessionMeta(file);
    expect(meta.messageCount).toBe(2);
  });
});
