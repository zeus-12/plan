import { describe, expect, it } from "vitest";
import { unwrapPastedContent } from "@/renderer/features/chat/transcript/message-kind";

describe("unwrapPastedContent", () => {
  it("unwraps a dictated/pasted prompt as Claude Code records it", () => {
    expect(
      unwrapPastedContent(
        '\n\n<pasted_content id="d7ec">\nAlso, one bug.\n\nSecond paragraph.\n</pasted_content id="d7ec">\n',
      ),
    ).toBe("Also, one bug.\n\nSecond paragraph.");
  });

  it("keeps typed text around the paste", () => {
    expect(
      unwrapPastedContent(
        '[Image #7]\n\n<pasted_content id="ab12">\nlook at this\n</pasted_content id="ab12">\n',
      ),
    ).toBe("[Image #7]\n\nlook at this");
  });

  it("unwraps several pastes independently", () => {
    expect(
      unwrapPastedContent(
        '<pasted_content id="a1">\none\n</pasted_content id="a1">\nmid\n<pasted_content id="b2">\ntwo\n</pasted_content id="b2">',
      ),
    ).toBe("one\nmid\ntwo");
  });

  it("leaves a pasted body that mentions another id's closing tag intact", () => {
    expect(
      unwrapPastedContent(
        '<pasted_content id="a1">\nsee </pasted_content id="zz"> here\n</pasted_content id="a1">',
      ),
    ).toBe('see </pasted_content id="zz"> here');
  });

  it("returns text without the wrapper unchanged", () => {
    expect(unwrapPastedContent("  plain prompt  ")).toBe("  plain prompt  ");
  });

  it("leaves tags that aren't a matched id pair untouched", () => {
    const cases = [
      "<pasted_content>\nno id\n</pasted_content>",
      'talking about <pasted_content id="a1"> tags',
      '<pasted_content id="a1">\nmismatched\n</pasted_content id="b2">',
    ];
    for (const t of cases) expect(unwrapPastedContent(t)).toBe(t);
  });
});
