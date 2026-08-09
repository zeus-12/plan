import { describe, expect, it } from "vitest";
import {
  hasImageResult,
  resultImagePreview,
} from "@/renderer/features/chat/transcript/tool-preview-card";

const block = (data: string, mediaType = "image/png") => ({
  type: "image",
  source: { type: "base64", data, media_type: mediaType },
});

describe("hasImageResult", () => {
  it("accepts a serialized image-block result", () => {
    expect(hasImageResult(JSON.stringify([block("iVBORw0")]))).toBe(true);
  });

  it("rejects text results and missing output", () => {
    expect(hasImageResult("     1\tconst a = 1")).toBe(false);
    expect(hasImageResult(JSON.stringify([{ type: "text", text: "hi" }]))).toBe(
      false,
    );
    expect(hasImageResult(undefined)).toBe(false);
  });
});

describe("resultImagePreview", () => {
  it("builds a data URL per image block", () => {
    const preview = resultImagePreview(
      "/p/snappy.png",
      JSON.stringify([block("AAAA"), block("BBBB", "image/jpeg")]),
    );
    expect(preview).toEqual({
      kind: "image",
      path: "/p/snappy.png",
      srcs: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    });
  });

  it("reads the media type wherever it sits in the block", () => {
    const output = JSON.stringify([
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: "CCCC" },
      },
    ]);
    expect(resultImagePreview("/p/a.webp", output)?.srcs).toEqual([
      "data:image/webp;base64,CCCC",
    ]);
  });

  it("drops blocks that don't carry base64 and a media type", () => {
    const output = JSON.stringify([
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
      { type: "image", source: { type: "base64", data: "DDDD" } },
      block("EEEE"),
    ]);
    expect(resultImagePreview("/p/a.png", output)?.srcs).toEqual([
      "data:image/png;base64,EEEE",
    ]);
  });

  it("returns null for a non-image or malformed result", () => {
    expect(resultImagePreview("/p/a.ts", "     1\tconst a = 1")).toBeNull();
    expect(resultImagePreview("/p/a.png", '[{"type":"image"')).toBeNull();
    expect(
      resultImagePreview(
        "/p/a.png",
        JSON.stringify([{ type: "image", source: { type: "base64" } }]),
      ),
    ).toBeNull();
  });
});
