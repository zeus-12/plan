import type { QueryCapture } from "web-tree-sitter";
import type { FoldRange } from "@plan/shared/code-folding";

/**
 * Turn a fold query's `@fold` captures into fold ranges.
 *
 * - One range per start row, keeping the widest (so an `if (...) {` whose
 *   statement and block both start on the same row yields a single fold).
 * - The region's LAST line is kept visible (`end = node.endRow - 1`) so a
 *   block's closing `}`/`)` stays on screen — matching VS Code and the
 *   indentation engine.
 * - Single-line captures (`end <= start`) produce no fold.
 *
 * Pure and DOM-free so it can be unit-tested in Node against real grammars.
 */
export function foldRangesFromCaptures(captures: QueryCapture[]): FoldRange[] {
  const byStart = new Map<number, number>();
  for (const c of captures) {
    if (c.name !== "fold") continue;
    const start = c.node.startPosition.row;
    const end = c.node.endPosition.row - 1;
    if (end <= start) continue;
    const prev = byStart.get(start);
    if (prev === undefined || end > prev) byStart.set(start, end);
  }
  return [...byStart.entries()]
    .map(([start, end]) => ({ start, end }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}
