/**
 * The strip of changed-file pills that closes an assistant turn.
 *
 * A turn is everything between two real user prompts — prose plus every tool
 * call in between, which in a Claude Code transcript is spread across many
 * assistant messages. The pills fold that back into one line: one pill per file
 * the turn wrote to, with the turn's line counts.
 *
 * Hovering a pill shows the turn's diff for that file, at whichever fidelity is
 * actually available. When file-replay can reconstruct the file's text either
 * side of the turn (see its header for when it can't), the card is a real file
 * diff — true line numbers, surrounding context, collapsed runs. When it can't,
 * the card falls back to the fragments the transcript holds: the same
 * before/after panels the individual tool rows show, with no line numbers,
 * because inventing them would be inventing them.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { buildDiffLines } from "@plan/shared/lib/diff/diff";
import { basename, relativeToCwd } from "@plan/shared/lib/path";
import { languageFromPath } from "@plan/shared/lib/syntax/highlight";
import type { ConversationMessage } from "@/common/shared-types";
import { isRealUserTurn } from "./message-kind";
import { buildFileOps, textAfterOp, type FileOp } from "./file-replay";
import {
  ToolPreviewCard,
  useToolPreviewHover,
  type ToolPreview,
} from "./tool-preview-card";

export interface TurnFileChange {
  path: string;
  language: string;
  /** Every op on this file across the whole session — replay needs the ones
   *  after this turn as much as the ones in it. */
  ops: FileOp[];
  /** This turn's slice of `ops`, inclusive. */
  firstOp: number;
  lastOp: number;
  added: number;
  removed: number;
}

function opFragment(op: FileOp): { oldText: string; newText: string } {
  return op.kind === "write"
    ? { oldText: "", newText: op.content }
    : { oldText: op.oldText, newText: op.newText };
}

const countCache = new WeakMap<FileOp, { added: number; removed: number }>();

function opCounts(op: FileOp): { added: number; removed: number } {
  const cached = countCache.get(op);
  if (cached) return cached;
  const { oldText, newText } = opFragment(op);
  let added = 0;
  let removed = 0;
  for (const line of buildDiffLines(oldText, newText)) {
    if (line.type === "add") added++;
    else if (line.type === "remove") removed++;
  }
  const counts = { added, removed };
  countCache.set(op, counts);
  return counts;
}

/**
 * Changed files per turn, keyed by the row index the strip renders on — the
 * turn's LAST row, so it lands at the visual end of the reply even when the
 * turn trails off into tool calls (the same anchor the reply meta row uses).
 * Turns that wrote no files get no entry.
 */
export function turnFileChangesByRow(
  items: ConversationMessage[],
): Map<number, TurnFileChange[]> {
  // Each row → the last row of the turn it belongs to, so an op anywhere in a
  // turn knows which strip it lands on.
  const turnEnd = new Array<number>(items.length).fill(-1);
  let start = -1;
  for (let i = 0; i <= items.length; i++) {
    const boundary = i === items.length || isRealUserTurn(items[i]);
    if (boundary) {
      if (start >= 0) for (let j = start; j < i; j++) turnEnd[j] = i - 1;
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }

  const out = new Map<number, TurnFileChange[]>();
  for (const [path, ops] of buildFileOps(items)) {
    const language = languageFromPath(path) || "plaintext";
    const perTurn = new Map<number, TurnFileChange>();
    ops.forEach((op, i) => {
      const row = turnEnd[op.row];
      if (row < 0) return;
      const { added, removed } = opCounts(op);
      const existing = perTurn.get(row);
      if (existing) {
        existing.lastOp = i;
        existing.added += added;
        existing.removed += removed;
        return;
      }
      perTurn.set(row, {
        path,
        language,
        ops,
        firstOp: i,
        lastOp: i,
        added,
        removed,
      });
    });
    for (const [row, change] of perTurn) {
      const list = out.get(row);
      if (list) list.push(change);
      else out.set(row, [change]);
    }
  }

  // Rebuilt per row so pills read in the order the turn touched the files,
  // rather than grouped by whichever file the timeline walked first.
  for (const [row, list] of out) {
    list.sort((a, b) => a.firstOp - b.firstOp);
    out.set(row, list);
  }
  return out;
}

/** The fragment card — what the transcript alone can prove. */
function fragmentPreview(file: TurnFileChange): ToolPreview {
  return {
    kind: "diff",
    path: file.path,
    language: file.language,
    edits: file.ops.slice(file.firstOp, file.lastOp + 1).map(opFragment),
  };
}

function FilePill({
  file,
  encoded,
  cwd,
}: {
  file: TurnFileChange;
  encoded: string;
  cwd: string | null;
}) {
  const hover = useToolPreviewHover();
  const [wanted, setWanted] = useState(false);
  // undefined = not read yet, null = unreadable (missing, binary, truncated).
  const [disk, setDisk] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!wanted || disk !== undefined) return;
    const relPath = relativeToCwd(file.path, cwd);
    if (!relPath) {
      setDisk(null);
      return;
    }
    let live = true;
    window.electronAPI
      .readProjectFile(encoded, relPath)
      .then((res) => {
        if (!live) return;
        setDisk(res && !res.binary && !res.truncated ? res.text : null);
      })
      .catch(() => live && setDisk(null));
    return () => {
      live = false;
    };
  }, [wanted, disk, file.path, cwd, encoded]);

  const preview = useMemo((): ToolPreview | null => {
    if (disk === undefined) return null;
    if (disk === null) return fragmentPreview(file);
    const newText = textAfterOp(file.ops, file.lastOp, disk);
    const oldText = textAfterOp(file.ops, file.firstOp - 1, disk);
    if (oldText === null || newText === null || oldText === newText) {
      return fragmentPreview(file);
    }
    return {
      kind: "file",
      path: file.path,
      language: file.language,
      oldText,
      newText,
    };
  }, [disk, file]);

  return (
    <>
      <span
        onMouseEnter={(e) => {
          setWanted(true);
          hover.onEnter(e.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={hover.onLeave}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-[5px] font-[family-name:var(--font-mono)] text-[11px] leading-none text-[var(--text-secondary)] transition-colors hover:border-[var(--text-tertiary)]"
      >
        <span className="min-w-0 truncate">{basename(file.path)}</span>
        {file.added > 0 && (
          <span style={{ color: "var(--diff-add-bar)" }}>+{file.added}</span>
        )}
        {file.removed > 0 && (
          <span style={{ color: "var(--diff-remove-bar)" }}>
            −{file.removed}
          </span>
        )}
      </span>
      {/* Held back until the read settles: opening on fragments and swapping to
          the file diff a frame later reads as a glitch. */}
      {hover.anchor &&
        preview &&
        createPortal(
          <ToolPreviewCard
            preview={preview}
            anchor={hover.anchor}
            onMouseEnter={hover.onCardEnter}
            onMouseLeave={hover.onCardLeave}
          />,
          document.body,
        )}
    </>
  );
}

export function TurnFilesStrip({
  files,
  encoded,
  cwd,
}: {
  files: TurnFileChange[];
  encoded: string;
  cwd: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-0.5 pt-1">
      {files.map((f) => (
        <FilePill key={f.path} file={f} encoded={encoded} cwd={cwd} />
      ))}
    </div>
  );
}
