import { describe, expect, it } from "vitest";
import {
  markdownAssetBase,
  resolveMarkdownAssetSrc,
} from "@/renderer/features/files/markdown-assets";

const base = markdownAssetBase("/repo/docs/guide.md", "docs/guide.md", 7);

describe("markdownAssetBase", () => {
  it("splits the project root off the file's own directory", () => {
    expect(base).toEqual({
      dirAbs: "/repo/docs",
      rootAbs: "/repo",
      revision: 7,
    });
  });

  it("reports no root when the absolute path doesn't end with the relative one", () => {
    expect(
      markdownAssetBase("/elsewhere/guide.md", "docs/guide.md", 1),
    ).toEqual({ dirAbs: "/elsewhere", rootAbs: null, revision: 1 });
  });
});

describe("resolveMarkdownAssetSrc", () => {
  it("resolves a source relative to the file", () => {
    expect(resolveMarkdownAssetSrc("./img/logo.png", base)).toBe(
      "file:///repo/docs/img/logo.png?v=7",
    );
    expect(resolveMarkdownAssetSrc("../assets/a.png", base)).toBe(
      "file:///repo/assets/a.png?v=7",
    );
  });

  it("resolves a root-absolute source against the project root", () => {
    expect(resolveMarkdownAssetSrc("/assets/a.png", base)).toBe(
      "file:///repo/assets/a.png?v=7",
    );
  });

  it("leaves an already-absolute URL alone", () => {
    for (const src of [
      "https://example.com/a.png",
      "data:image/png;base64,AAA",
      "file:///tmp/a.png",
      "//cdn.example.com/a.png",
    ]) {
      expect(resolveMarkdownAssetSrc(src, base)).toBe(src);
    }
  });

  it("leaves a source that escapes the project alone", () => {
    expect(resolveMarkdownAssetSrc("../../secret.png", base)).toBe(
      "../../secret.png",
    );
  });

  it("leaves every relative source alone when there is no base", () => {
    const none = { dirAbs: "", rootAbs: null, revision: 1 };
    expect(resolveMarkdownAssetSrc("./a.png", none)).toBe("./a.png");
    expect(resolveMarkdownAssetSrc("/a.png", none)).toBe("/a.png");
  });

  it("escapes characters that would truncate the URL", () => {
    expect(resolveMarkdownAssetSrc("a b#c?d.png", base)).toBe(
      "file:///repo/docs/a%20b%23c%3Fd.png?v=7",
    );
  });

  it("keeps a root-absolute source inside the project when no root is known", () => {
    const noRoot = markdownAssetBase("/elsewhere/guide.md", "docs/guide.md", 1);
    expect(resolveMarkdownAssetSrc("/a.png", noRoot)).toBe("/a.png");
  });
});
