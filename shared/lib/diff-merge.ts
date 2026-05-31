import type { DiffLine } from "./diff";

export interface Change {
  /** Index of the first line of this change within the diff-lines array. */
  startLineIdx: number;
  endLineIdx: number;
  removed: DiffLine[];
  added: DiffLine[];
}

/**
 * Group consecutive non-context diff lines into "changes". A change is a run
 * of one or more remove/add lines (replace, pure delete, or pure insert).
 */
export function computeChanges(lines: DiffLine[]): Change[] {
  const out: Change[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      i++;
      continue;
    }
    const startIdx = i;
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type !== "context") {
      if (lines[i].type === "remove") removed.push(lines[i]);
      else added.push(lines[i]);
      i++;
    }
    out.push({
      startLineIdx: startIdx,
      endLineIdx: i - 1,
      removed,
      added,
    });
  }
  return out;
}

/** Map from a diff-lines index to the change it belongs to (if any). */
export function buildLineToChangeMap(
  changes: Change[]
): Map<number, number> {
  const map = new Map<number, number>();
  for (let ci = 0; ci < changes.length; ci++) {
    const c = changes[ci];
    for (let li = c.startLineIdx; li <= c.endLineIdx; li++) {
      map.set(li, ci);
    }
  }
  return map;
}

function precedingContext(lines: DiffLine[], startIdx: number): DiffLine | null {
  for (let j = startIdx - 1; j >= 0; j--) {
    if (lines[j].type === "context") return lines[j];
  }
  return null;
}

function replaceLines(
  text: string,
  fromLine: number,
  toLine: number,
  newLines: string[]
): string {
  // 1-based inclusive line range.
  const parts = text.split("\n");
  const before = parts.slice(0, fromLine - 1);
  const after = parts.slice(toLine);
  return [...before, ...newLines, ...after].join("\n");
}

function insertLines(
  text: string,
  beforeLine: number,
  newLines: string[]
): string {
  const parts = text.split("\n");
  const before = parts.slice(0, beforeLine - 1);
  const after = parts.slice(beforeLine - 1);
  return [...before, ...newLines, ...after].join("\n");
}

/**
 * Accept the right side's version for this change. Returns the new left text.
 */
export function applyChangeRightToLeft(
  left: string,
  change: Change,
  lines: DiffLine[]
): string {
  if (change.removed.length > 0) {
    const fromLine = change.removed[0].oldNum!;
    const toLine = change.removed[change.removed.length - 1].oldNum!;
    return replaceLines(
      left,
      fromLine,
      toLine,
      change.added.map((l) => l.content)
    );
  }
  // Pure insertion (only added lines exist) — splice into left
  const prev = precedingContext(lines, change.startLineIdx);
  const insertAt = prev ? prev.oldNum! + 1 : 1;
  return insertLines(left, insertAt, change.added.map((l) => l.content));
}

/**
 * Discard the right side's version of this change — make right look like left.
 * Returns the new right text.
 */
export function applyChangeLeftToRight(
  right: string,
  change: Change,
  lines: DiffLine[]
): string {
  if (change.added.length > 0) {
    const fromLine = change.added[0].newNum!;
    const toLine = change.added[change.added.length - 1].newNum!;
    return replaceLines(
      right,
      fromLine,
      toLine,
      change.removed.map((l) => l.content)
    );
  }
  const prev = precedingContext(lines, change.startLineIdx);
  const insertAt = prev ? prev.newNum! + 1 : 1;
  return insertLines(right, insertAt, change.removed.map((l) => l.content));
}
