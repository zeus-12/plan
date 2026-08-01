import type { BracketPos } from "./shiki";

/**
 * Bracket-pair colorization. Given the positions of the *real code* brackets
 * (from {@link codeBracketPositions}, which uses TextMate scopes to exclude any
 * bracket inside a string, comment, or regex), colour them by nesting depth with
 * a matching stack. Matched open/close pairs share a colour; an unmatched
 * bracket (broken/incomplete code) is flagged. Returns marks grouped by line.
 *
 * This deliberately does NOT inspect source text — the hard part (which brackets
 * are real) is decided by the tokenizer's scopes, not by string matching.
 */

const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function isOpenChar(c: string): boolean {
  return c === "(" || c === "[" || c === "{";
}

/** A bracket character to recolor: its column in the line and the colour. */
export interface BracketMark {
  col: number;
  color: string;
}

// Cycled by nesting depth. CSS vars let a theme override; the fallbacks are
// VS Code's default bracket colours.
const DEPTH_COLORS = [
  "var(--bracket-1, #ffd700)",
  "var(--bracket-2, #da70d6)",
  "var(--bracket-3, #179fff)",
];
const UNMATCHED_COLOR = "var(--bracket-unmatched, #e2474a)";

export function bracketColorsByLine(
  positions: BracketPos[],
): Map<number, BracketMark[]> {
  // Source order (line, then column) is what the stack matching needs.
  const ordered = [...positions].sort(
    (a, b) => a.line - b.line || a.col - b.col,
  );
  const out = new Map<number, BracketMark[]>();
  const stack: string[] = [];

  for (const p of ordered) {
    let color: string;
    if (isOpenChar(p.char)) {
      color = DEPTH_COLORS[stack.length % DEPTH_COLORS.length];
      stack.push(p.char);
    } else if (stack.length && stack[stack.length - 1] === OPEN_OF[p.char]) {
      stack.pop();
      color = DEPTH_COLORS[stack.length % DEPTH_COLORS.length];
    } else {
      color = UNMATCHED_COLOR;
    }
    let marks = out.get(p.line);
    if (!marks) {
      marks = [];
      out.set(p.line, marks);
    }
    marks.push({ col: p.col, color });
  }
  return out;
}
