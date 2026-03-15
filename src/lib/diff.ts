import { diffLines } from "diff";

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldNum?: number;
  newNum?: number;
  idx: number;
  flatOffset: number;
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

export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
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

  return result;
}

export function filterUnchangedLines(
  dLines: DiffLine[],
  ctx: number = CONTEXT_LINES_AROUND_CHANGES
): FilteredItem[] {
  const hasChanges = dLines.some((l) => l.type !== "context");
  if (!hasChanges) return dLines;

  const visible = new Array(dLines.length).fill(false);

  for (let i = 0; i < dLines.length; i++) {
    if (dLines[i].type !== "context") {
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

    while (
      i < items.length &&
      items[i].type === "remove"
    ) {
      removes.push(items[i] as DiffLine);
      i++;
    }
    while (
      i < items.length &&
      items[i].type === "add"
    ) {
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
  dLines: DiffLine[]
): number {
  for (let i = 0; i < dLines.length; i++) {
    if (offset <= dLines[i].flatOffset + dLines[i].content.length) return i;
  }
  return dLines.length - 1;
}
