import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { readSentFile } from "@/main/fs/sent-file";
import {
  formatBytes,
  parseCsv,
  parseSendUserFile,
  sentFilePreview,
} from "@/renderer/features/chat/transcript/sent-file";
import type { SentFile } from "@/common/shared-types";

const HEAD_BYTES = 256 * 1024;

async function tmpFile(name: string, content: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "plan-sent-"));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("parseSendUserFile", () => {
  it("takes the file list and the caption", () => {
    expect(
      parseSendUserFile({
        files: ["/tmp/a.csv"],
        caption: "  All 109 tools  ",
        display: "attach",
      }),
    ).toEqual({ files: ["/tmp/a.csv"], caption: "All 109 tools" });
  });

  it("is null without a usable path, so the row falls back to the raw block", () => {
    expect(parseSendUserFile({ files: [] })).toBeNull();
    expect(parseSendUserFile({ files: [42, ""] })).toBeNull();
    expect(parseSendUserFile("nonsense")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("keeps commas, newlines and escaped quotes inside a quoted field", () => {
    const rows = parseCsv('a,"b,c","line1\nline2","say ""hi"""\n', 10);
    expect(rows).toEqual([["a", "b,c", "line1\nline2", 'say "hi"']]);
  });

  it("stops at the row cap rather than parsing the whole head", () => {
    const text = Array.from({ length: 500 }, (_, i) => `${i},x`).join("\n");
    expect(parseCsv(text, 20)).toHaveLength(20);
  });

  it("handles CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2", 10)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("formatBytes", () => {
  it("reports base-10 units", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(84_000)).toBe("84 KB");
    expect(formatBytes(4_200_000)).toBe("4.2 MB");
  });
});

describe("readSentFile", () => {
  it("returns the whole file when it fits under the cap", async () => {
    const path = await tmpFile("small.csv", "a,b\n1,2\n");
    const file = await readSentFile(path);
    expect(file).toMatchObject({ kind: "text", complete: true, size: 8 });
    expect(file!.text).toBe("a,b\n1,2\n");
  });

  it("reads only the head of a file past the cap, cut at a line boundary", async () => {
    const line = `${"x".repeat(99)}\n`;
    const path = await tmpFile("big.txt", line.repeat(4000)); // 400 KB
    const file = await readSentFile(path);
    expect(file!.complete).toBe(false);
    expect(file!.text.length).toBeLessThanOrEqual(HEAD_BYTES);
    // Cut on a newline: every line the preview shows is a whole line.
    expect(file!.text.endsWith("\n")).toBe(true);
    expect(
      file!.text
        .split("\n")
        .filter(Boolean)
        .every((l) => l.length === 99),
    ).toBe(true);
  });

  it("never emits a replacement char when the cap splits a multi-byte character", async () => {
    // 3 bytes each, so the 256 KB boundary lands mid-character.
    const path = await tmpFile("wide.txt", `${"あ".repeat(200_000)}\nx\n`);
    const file = await readSentFile(path);
    expect(file!.complete).toBe(false);
    expect(file!.text).not.toContain("�");
  });

  it("reports a binary without reading it as text", async () => {
    const path = await tmpFile("blob.bin", Buffer.from([1, 2, 0, 3, 4]));
    expect(await readSentFile(path)).toMatchObject({
      kind: "binary",
      text: "",
      size: 5,
    });
  });

  it("hands an image back as a URL, with no bytes", async () => {
    const path = await tmpFile("shot.png", Buffer.from([0x89, 0x50, 0x4e]));
    const file = await readSentFile(path);
    expect(file).toMatchObject({ kind: "image", text: "" });
    expect(file!.url.startsWith("file://")).toBe(true);
  });

  it("is null for a file that isn't there", async () => {
    expect(await readSentFile("/tmp/plan-does-not-exist-9f2a.csv")).toBeNull();
  });
});

const asFile = (over: Partial<SentFile>): SentFile => ({
  size: 100,
  mtimeMs: 0,
  kind: "text",
  url: "",
  text: "",
  complete: true,
  ...over,
});

describe("sentFilePreview", () => {
  it("counts rows only when it holds the whole file", () => {
    const preview = sentFilePreview(
      "/tmp/scores.csv",
      asFile({ text: "a,b\n1,2\n3,4\n", size: 12 }),
    );
    expect(preview).toMatchObject({ kind: "table", meta: "2 rows · 12 bytes" });
  });

  it("says 'first N' and states no total for a partial read", () => {
    const preview = sentFilePreview(
      "/tmp/events.csv",
      asFile({ text: "a,b\n1,2\n", size: 412_000_000, complete: false }),
    );
    expect(preview).toMatchObject({
      kind: "table",
      meta: "first 1 row · 412 MB",
    });
  });

  it("drops a final row the byte cut left short", () => {
    const preview = sentFilePreview(
      "/tmp/events.csv",
      asFile({ text: "a,b,c\n1,2,3\n4,5\n", size: 999_999, complete: false }),
    );
    expect(preview).toMatchObject({ kind: "table", rows: [["1", "2", "3"]] });
  });

  it("renders a non-CSV text file as text", () => {
    const preview = sentFilePreview(
      "/tmp/notes.md",
      asFile({ text: "# Title\nbody\n", size: 13 }),
    );
    expect(preview).toMatchObject({
      kind: "text",
      text: "# Title\nbody",
      meta: "2 lines · 13 bytes",
    });
  });

  it("has nothing to show for a binary", () => {
    expect(
      sentFilePreview("/tmp/archive.zip", asFile({ kind: "binary" })),
    ).toBeNull();
  });
});
