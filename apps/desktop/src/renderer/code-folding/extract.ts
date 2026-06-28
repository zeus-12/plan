import type { QueryCapture, QueryMatch } from "web-tree-sitter";
import type { CodeSymbol, FoldRange } from "@plan/shared/code-folding";

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

/**
 * Turn a tags query's matches into code symbols. Each match pairs a `@name`
 * capture (the identifier) with a `@definition.<kind>` capture (the whole def
 * node); we take the name's text, the kind, and the definition's line. Sorted by
 * line. Pure and DOM-free so it can be unit-tested in Node.
 */
export function symbolsFromMatches(matches: QueryMatch[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const match of matches) {
    let name: string | null = null;
    let kind: string | null = null;
    let line = -1;
    for (const c of match.captures) {
      if (c.name === "name") {
        name = c.node.text;
        if (line < 0) line = c.node.startPosition.row;
      } else if (c.name.startsWith("definition.")) {
        kind = c.name.slice("definition.".length);
        line = c.node.startPosition.row;
      }
    }
    if (name && kind) symbols.push({ name, kind, line });
  }
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}
