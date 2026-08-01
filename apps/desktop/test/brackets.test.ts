import { describe, expect, it } from "vitest";
import { bracketColorsByLine } from "../../../shared/lib/syntax/brackets";
import type { BracketPos } from "../../../shared/lib/syntax/shiki";

// Real-bracket positions are produced by codeBracketPositions (scope-aware, so
// string/comment/regex brackets are already excluded). These tests cover the
// depth-colouring + matching done over those positions.
const p = (col: number, char: string, line = 0): BracketPos => ({
  line,
  col,
  char,
});

describe("bracket-pair colorization (depth colouring)", () => {
  it("matched open/close share a colour; nested differ", () => {
    // "([])" → ( [ ] )
    const m = bracketColorsByLine([
      p(0, "("),
      p(1, "["),
      p(2, "]"),
      p(3, ")"),
    ]).get(0)!;
    const at = (c: number) => m.find((x) => x.col === c)!.color;
    expect(at(0)).toBe(at(3)); // ( matches )
    expect(at(1)).toBe(at(2)); // [ matches ]
    expect(at(0)).not.toBe(at(1)); // depth 0 vs 1
  });

  it("template interpolation braces balance (codeBracketPositions emits both)", () => {
    // `(${})` real code brackets: ( at0, { at2 (the { of ${), } at3, ) at4
    const m = bracketColorsByLine([
      p(0, "("),
      p(2, "{"),
      p(3, "}"),
      p(4, ")"),
    ]).get(0)!;
    const at = (c: number) => m.find((x) => x.col === c)!.color;
    expect(at(0)).toBe(at(4));
    expect(at(2)).toBe(at(3));
    expect(at(0)).not.toBe(at(2));
  });

  it("flags an unmatched closing bracket", () => {
    const m = bracketColorsByLine([p(0, ")")]).get(0)!;
    expect(m[0].color).toContain("--bracket-unmatched");
  });

  it("colours pairs the same across lines", () => {
    const open = bracketColorsByLine([p(0, "{", 0), p(0, "}", 5)]);
    expect(open.get(0)![0].color).toBe(open.get(5)![0].color);
  });
});
