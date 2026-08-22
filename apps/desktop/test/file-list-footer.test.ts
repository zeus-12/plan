import { describe, expect, it } from "vitest";
import { shouldShowOtherReposHeading } from "@/renderer/features/git/file-list-footer";

describe("file list sync footer", () => {
  it("does not label the only repository as another repository", () => {
    expect(shouldShowOtherReposHeading(1)).toBe(false);
  });

  it("groups sync targets separately when the project has multiple repositories", () => {
    expect(shouldShowOtherReposHeading(2)).toBe(true);
  });
});
