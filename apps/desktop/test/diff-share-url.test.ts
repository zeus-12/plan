import { describe, expect, it } from "vitest";
import {
  buildDiffUrl,
  decodeDiffState,
  DIFF_HASH_PREFIX,
  encodeDiffState,
} from "@plan/shared/lib/share/diff-share-url";

describe("diff share URLs", () => {
  it("round-trips both versions and the language", () => {
    const state = {
      left: "const answer = 41;\n",
      right: "const answer = 42;\n",
      language: "typescript",
    };

    expect(decodeDiffState(encodeDiffState(state))).toEqual(state);
  });

  it("builds a root web URL without duplicating slashes", () => {
    const url = buildDiffUrl(
      { left: "before", right: "after" },
      "https://plan.example.com/",
    );

    expect(url).toMatch(
      new RegExp(`^https://plan\\.example\\.com/${DIFF_HASH_PREFIX}`),
    );
    expect(
      decodeDiffState(url.slice(url.indexOf(DIFF_HASH_PREFIX) + 3)),
    ).toEqual({ left: "before", right: "after", language: undefined });
  });

  it("rejects malformed state", () => {
    expect(decodeDiffState("not-a-valid-payload")).toBeNull();
  });
});
