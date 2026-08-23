import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InteractiveDiff } from "@plan/shared/components/diff/interactive-diff";

describe("InteractiveDiff without an element scroller", () => {
  it("renders changed rows beyond the first collapsed separator", () => {
    const context = Array.from(
      { length: 40 },
      (_, i) => `const line${i} = ${i};`,
    ).join("\n");
    const right = `${context}\nconst shared = true;\n`;

    const html = renderToStaticMarkup(
      createElement(InteractiveDiff, {
        oldText: `${context}\n`,
        newText: right,
        settings: {
          viewMode: "split",
          hideUnchanged: true,
          fontSize: 13,
          lineWrap: false,
          ignoreWhitespace: false,
        },
        separators: {
          expanded: new Set<number>(),
          customized: false,
          toggle: () => undefined,
          expandAll: () => undefined,
          collapseAll: () => undefined,
        },
      }),
    );

    expect(html).toContain("37 unchanged lines");
    expect(html).toContain("const shared = true;");
  });
});
