/**
 * Indentation-based code folding — a faithful port of VS Code's default folding
 * strategy (the one the editor falls back to for any language without a
 * dedicated folding-range provider, i.e. `editor.foldingStrategy: "indentation"`).
 *
 * A region starts at a line whose following lines are more indented and ends at
 * the last more-indented line before the indent returns to the start line's
 * level or less. Blank lines are ignored when measuring indent and never end a
 * region on their own (trailing blanks are trimmed off the region).
 *
 * It is deliberately language-agnostic: it never inspects characters beyond
 * leading whitespace, so it has none of the string/comment/regex pitfalls of
 * brace matching. It reproduces VS Code's on-screen folding for the common
 * cases (function bodies, object/JSON trees, arrays, JSX) because those blocks
 * are always indented — e.g. `function f() {` at indent 0 folds its indented
 * body and leaves the closing `}` (back at indent 0) visible, exactly like VS
 * Code.
 */

export interface FoldRange {
  /** 0-based index of the line that stays visible and carries the fold toggle. */
  start: number;
  /** 0-based index of the last line inside the region (inclusive; hidden when collapsed). */
  end: number;
}

/** A region must hide at least this many lines to be worth a fold toggle. */
const MIN_HIDDEN_LINES = 1;

/** Leading-whitespace indent width, or -1 for a blank/whitespace-only line. */
function indentWidth(line: string, tabSize: number): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 32 /* space */) width++;
    else if (ch === 9 /* tab */) width += tabSize - (width % tabSize);
    else return width;
  }
  return -1; // only whitespace (or empty)
}

/**
 * Foldable ranges for `lines`, computed purely from indentation. Starts are
 * unique (each line opens at most one region), so {@link foldRangeMap} can key
 * ranges by their start line unambiguously.
 */
export function computeFoldRanges(lines: string[], tabSize = 4): FoldRange[] {
  const n = lines.length;
  const ranges: FoldRange[] = [];
  // Open regions, deepest last (indent strictly increases down the stack).
  const stack: { line: number; indent: number }[] = [];
  let lastNonBlank = -1;

  for (let i = 0; i < n; i++) {
    const indent = indentWidth(lines[i], tabSize);
    if (indent === -1) continue; // blank — only swallowed if deeper lines follow
    // Every open region at indent >= this line's ends at the previous non-blank
    // line (the indent has returned to its level or shallower).
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const top = stack.pop()!;
      if (lastNonBlank - top.line >= MIN_HIDDEN_LINES) {
        ranges.push({ start: top.line, end: lastNonBlank });
      }
    }
    stack.push({ line: i, indent });
    lastNonBlank = i;
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (lastNonBlank - top.line >= MIN_HIDDEN_LINES) {
      ranges.push({ start: top.line, end: lastNonBlank });
    }
  }
  // Top-to-bottom, outermost-first for ties (ties can't actually occur since
  // starts are unique, but keep the order deterministic).
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  return ranges;
}

/** Index foldable ranges by their start line. */
export function foldRangeMap(ranges: FoldRange[]): Map<number, FoldRange> {
  const map = new Map<number, FoldRange>();
  for (const r of ranges) map.set(r.start, r);
  return map;
}

/**
 * The set of line indices hidden by the currently-collapsed regions. A region's
 * start line stays visible; its body (start+1 … end) is hidden. Nested folds
 * union naturally — a line hidden by an outer fold stays hidden regardless of
 * the inner one's state.
 */
export function hiddenLineSet(
  collapsed: Iterable<number>,
  byStart: Map<number, FoldRange>,
): Set<number> {
  const hidden = new Set<number>();
  for (const start of collapsed) {
    const r = byStart.get(start);
    if (!r) continue;
    for (let i = r.start + 1; i <= r.end; i++) hidden.add(i);
  }
  return hidden;
}

/**
 * The currently-collapsed regions that hide `line` — so revealing the line
 * (a search hit, a ⌘P jump, a stepped find match) means re-opening exactly
 * these. Empty when the line is already visible.
 */
export function collapsedRangesContaining(
  line: number,
  collapsed: Iterable<number>,
  byStart: Map<number, FoldRange>,
): number[] {
  const out: number[] = [];
  for (const start of collapsed) {
    const r = byStart.get(start);
    if (r && line > r.start && line <= r.end) out.push(start);
  }
  return out;
}
