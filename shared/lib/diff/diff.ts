import { createTwoFilesPatch, diffLines, diffWordsWithSpace } from "diff";

export interface WordSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldNum?: number;
  newNum?: number;
  idx: number;
  flatOffset: number;
  wordSegments?: WordSegment[];
  whitespaceOnly?: boolean;
}

export interface Separator {
  type: "separator";
  hiddenCount: number;
}

export type FilteredItem = DiffLine | Separator;

export interface SplitPair {
  type: "pair";
  left?: DiffLine;
  right?: DiffLine;
}

export type SplitRow = SplitPair | Separator;

const CONTEXT_LINES_AROUND_CHANGES = 3;

/**
 * A standard unified diff (the `git diff` text format) between two strings —
 * for copying to the clipboard to paste into an LLM. Only the changed hunks
 * (with a few lines of context) are included, so it stays compact and is the
 * representation models read most reliably.
 */
export function formatUnifiedDiff(oldText: string, newText: string): string {
  const patch = createTwoFilesPatch(
    "original",
    "changed",
    oldText ?? "",
    newText ?? "",
  );
  // jsdiff prefixes an "===" separator line; drop everything before the
  // "--- original" header so the result is a clean unified diff.
  const start = patch.indexOf("--- ");
  const body = start >= 0 ? patch.slice(start) : patch;
  return body.replace(/\t(?=\n)/g, "").trimEnd() + "\n";
}

export function buildDiffLines(
  oldText: string,
  newText: string,
  ignoreWhitespace = false,
): DiffLine[] {
  const changes = diffLines(oldText || "", newText || "");
  const result: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  let flatOffset = 0;

  for (const change of changes) {
    const lines = change.value.split("\n");
    if (lines.at(-1) === "") lines.pop();

    for (const line of lines) {
      const dl: DiffLine = {
        type: change.added ? "add" : change.removed ? "remove" : "context",
        content: line,
        idx: result.length,
        flatOffset,
      };

      if (change.added) {
        dl.newNum = newNum++;
      } else if (change.removed) {
        dl.oldNum = oldNum++;
      } else {
        dl.oldNum = oldNum++;
        dl.newNum = newNum++;
      }

      result.push(dl);
      flatOffset += line.length + 1;
    }
  }

  computeWordDiffs(result);
  if (ignoreWhitespace) markWhitespaceOnlyChanges(result);
  return result;
}

function computeWordDiffs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "remove") {
      i++;
      continue;
    }

    const removes: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "remove") {
      removes.push(lines[i]);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i]);
      i++;
    }

    const pairs = Math.min(removes.length, adds.length);
    for (let j = 0; j < pairs; j++) {
      const changes = diffWordsWithSpace(removes[j].content, adds[j].content);
      removes[j].wordSegments = changes
        .filter((c) => !c.added)
        .map((c) => ({ text: c.value, changed: !!c.removed }));
      adds[j].wordSegments = changes
        .filter((c) => !c.removed)
        .map((c) => ({ text: c.value, changed: !!c.added }));
    }
  }
}

function markWhitespaceOnlyChanges(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "remove") {
      if (lines[i].type === "add" && lines[i].content.trim() === "") {
        lines[i].whitespaceOnly = true;
      }
      i++;
      continue;
    }

    const removes: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "remove") {
      removes.push(lines[i]);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i]);
      i++;
    }

    const pairs = Math.min(removes.length, adds.length);
    for (let j = 0; j < pairs; j++) {
      if (removes[j].content.trim() === adds[j].content.trim()) {
        removes[j].whitespaceOnly = true;
        adds[j].whitespaceOnly = true;
      }
    }

    for (let j = pairs; j < removes.length; j++) {
      if (removes[j].content.trim() === "") {
        removes[j].whitespaceOnly = true;
      }
    }
    for (let j = pairs; j < adds.length; j++) {
      if (adds[j].content.trim() === "") {
        adds[j].whitespaceOnly = true;
      }
    }
  }
}

export function filterUnchangedLines(
  dLines: DiffLine[],
  ctx: number = CONTEXT_LINES_AROUND_CHANGES,
): FilteredItem[] {
  if (dLines.length === 0) return [];
  const isRealChange = (l: DiffLine) =>
    l.type !== "context" && !l.whitespaceOnly;
  const hasChanges = dLines.some(isRealChange);
  if (!hasChanges) {
    return [{ type: "separator", hiddenCount: dLines.length }];
  }

  const visible = new Array(dLines.length).fill(false);

  for (let i = 0; i < dLines.length; i++) {
    if (isRealChange(dLines[i])) {
      const lo = Math.max(0, i - ctx);
      const hi = Math.min(dLines.length - 1, i + ctx);
      for (let j = lo; j <= hi; j++) visible[j] = true;
    }
  }

  const result: FilteredItem[] = [];
  let i = 0;

  while (i < dLines.length) {
    if (visible[i]) {
      result.push(dLines[i]);
      i++;
    } else {
      let count = 0;
      while (i < dLines.length && !visible[i]) {
        count++;
        i++;
      }
      result.push({ type: "separator", hiddenCount: count });
    }
  }

  return result;
}

export function buildSplitRows(items: FilteredItem[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];

    if (item.type === "separator") {
      rows.push(item);
      i++;
      continue;
    }

    if (item.type === "context") {
      rows.push({ type: "pair", left: item, right: item });
      i++;
      continue;
    }

    // Collect consecutive removes then adds
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];

    while (i < items.length && items[i].type === "remove") {
      removes.push(items[i] as DiffLine);
      i++;
    }
    while (i < items.length && items[i].type === "add") {
      adds.push(items[i] as DiffLine);
      i++;
    }

    const max = Math.max(removes.length, adds.length);
    for (let j = 0; j < max; j++) {
      rows.push({
        type: "pair",
        left: j < removes.length ? removes[j] : undefined,
        right: j < adds.length ? adds[j] : undefined,
      });
    }
  }

  return rows;
}

export function getDiffLineForOffset(
  offset: number,
  dLines: DiffLine[],
): number {
  for (let i = 0; i < dLines.length; i++) {
    if (offset <= dLines[i].flatOffset + dLines[i].content.length) return i;
  }
  return dLines.length - 1;
}

/* ── Annotation anchors ───────────────────────────────────────────────────────
 * Comment offsets index the FLAT DIFF TEXT — every diff line (removed, added
 * and context, in render order) joined by newlines — not the old/new file text.
 * That's the space `InteractiveDiff` resolves selections in, so both the file
 * line numbers a comment reports and any "is this anchor still valid" check
 * have to go back through the diff lines. These helpers are that seam.
 */

/** A comment's [startOffset, endOffset) on one side of the diff. */
export interface DiffAnchorRange {
  startOffset: number;
  endOffset: number;
  side: "left" | "right";
}

/** The diff lines a flat range touches, as [firstIdx, lastIdx]. */
function coveredLines(
  dLines: DiffLine[],
  { startOffset, endOffset }: DiffAnchorRange,
): [number, number] {
  const first = getDiffLineForOffset(startOffset, dLines);
  const last = getDiffLineForOffset(
    Math.max(startOffset, endOffset - 1),
    dLines,
  );
  return [first, Math.max(first, last)];
}

/** Does this diff line show on `side`? (An added line has no left-side row.) */
function onSide(line: DiffLine, side: "left" | "right"): boolean {
  return side === "left" ? line.type !== "add" : line.type !== "remove";
}

/**
 * The 1-based file line numbers a comment covers, in the file the side shows
 * (old file for "left", new for "right"). Rows belonging only to the other side
 * carry no number here, so the range is narrowed to the outermost lines that do
 * — undefined only if the selection touches no line of its own side at all.
 */
export function diffAnchorLines(
  dLines: DiffLine[],
  anchor: DiffAnchorRange,
): { startLine?: number; endLine?: number } {
  const [first, last] = coveredLines(dLines, anchor);
  const numberOf = (l: DiffLine) =>
    anchor.side === "left" ? l.oldNum : l.newNum;
  let startLine: number | undefined;
  let endLine: number | undefined;
  for (let i = first; i <= last && startLine === undefined; i++) {
    startLine = numberOf(dLines[i]);
  }
  for (let i = last; i >= first && endLine === undefined; i--) {
    endLine = numberOf(dLines[i]);
  }
  return { startLine, endLine };
}

/**
 * Is `selectedText` still the text sitting at this anchor in the given diff?
 *
 * The stored text is whatever the DOM selection produced, which varies by view
 * mode (split yields only the commented side's rows; unified yields every row
 * in between) and can omit rows hidden by a fold. So rather than one exact
 * slice, this checks that the selection's lines still appear, in order, among
 * the lines the range covers. Anything less would delete comments the user can
 * plainly see anchored; anything more would keep comments pointing at text that
 * has since changed on disk.
 */
export function diffAnchorMatches(
  dLines: DiffLine[],
  anchor: DiffAnchorRange,
  selectedText: string,
): boolean {
  if (anchor.startOffset < 0 || anchor.endOffset > flatLength(dLines))
    return false;
  const [first, last] = coveredLines(dLines, anchor);

  const covered: string[] = [];
  for (let i = first; i <= last; i++) {
    const line = dLines[i];
    if (!onSide(line, anchor.side)) continue;
    covered.push(
      line.content.slice(
        Math.max(0, anchor.startOffset - line.flatOffset),
        Math.min(line.content.length, anchor.endOffset - line.flatOffset),
      ),
    );
  }

  const wanted = selectedText.split("\n");
  let at = 0;
  for (const line of wanted) {
    while (
      at < covered.length &&
      covered[at] !== line &&
      covered[at].trim() !== line.trim()
    ) {
      at++;
    }
    if (at === covered.length) return false;
    at++;
  }
  return true;
}

function flatLength(dLines: DiffLine[]): number {
  const last = dLines.at(-1);
  return last ? last.flatOffset + last.content.length : 0;
}
