"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { highlightPerLine, type SyntaxToken } from "../lib/highlight";
import { useShikiReady, useActiveShikiTheme } from "../lib/shiki";
import { useCommentSelection } from "../lib/use-comment-selection";
import { CommentPopover } from "./comment-popover";
import type { DocComment } from "../lib/doc-share-url";

interface DocViewProps {
  text: string;
  language: string;
  comments: DocComment[];
  /** When provided, selecting text opens a comment popover. */
  onAddComment?: (
    start: number,
    end: number,
    quote: string,
    body: string,
  ) => void;
  onRemoveComment?: (id: string) => void;
  /** Two-way hover link with an external comments list. */
  activeCommentId?: string | null;
  onActiveCommentChange?: (id: string | null) => void;
  /** Monospace font size in px (default 13). */
  fontSize?: number;
  /** Wrap long lines (default) vs. scroll horizontally. */
  lineWrap?: boolean;
}

/** A contiguous run of the line sharing one color + highlight state. */
interface Segment {
  text: string;
  color?: string;
  italic?: boolean;
  bold?: boolean;
  commentIds: string[];
}

/** Within-line highlight interval carrying the comment ids that cover it. */
interface LineRange {
  start: number;
  end: number;
  ids: string[];
}

function buildSegments(
  lineText: string,
  tokens: SyntaxToken[],
  ranges: LineRange[],
): Segment[] {
  const len = lineText.length;
  if (len === 0) return [];
  const bounds = new Set<number>([0, len]);
  for (const t of tokens) {
    bounds.add(Math.max(0, Math.min(len, t.start)));
    bounds.add(Math.max(0, Math.min(len, t.end)));
  }
  for (const r of ranges) {
    bounds.add(Math.max(0, Math.min(len, r.start)));
    bounds.add(Math.max(0, Math.min(len, r.end)));
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === b) continue;
    const tok = tokens.find((t) => t.start <= a && a < t.end);
    const covering = ranges.filter((r) => r.start <= a && a < r.end);
    segments.push({
      text: lineText.slice(a, b),
      color: tok?.color,
      italic: tok?.italic,
      bold: tok?.bold,
      commentIds: covering.flatMap((r) => r.ids),
    });
  }
  return segments;
}

/** Closest code cell ancestor of a DOM node, or null. */
function cellOf(node: Node): HTMLElement | null {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  return el?.closest<HTMLElement>("[data-line-start]") ?? null;
}

/** Number of characters within `cell` before (node, offset). */
function offsetWithinCell(
  cell: Element,
  node: Node,
  nodeOffset: number,
): number {
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.setEnd(node, nodeOffset);
  return r.toString().length;
}

export function DocView({
  text,
  language,
  comments,
  onAddComment,
  onRemoveComment,
  activeCommentId,
  onActiveCommentChange,
  fontSize = 13,
  lineWrap = true,
}: DocViewProps) {
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => text.split("\n"), [text]);

  // Absolute start offset of each line in `text`.
  const lineStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const line of lines) {
      starts.push(acc);
      acc += line.length + 1; // +1 for the newline
    }
    return starts;
  }, [lines]);

  const perLineTokens = useMemo(
    () => highlightPerLine(text, language),
    // Re-tokenize once shiki loads and on theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, language, shikiReady, shikiTheme],
  );

  // Map each line index -> the within-line highlight intervals from comments.
  const rangesByLine = useMemo(() => {
    const map = new Map<number, LineRange[]>();
    for (const c of comments) {
      if (c.end <= c.start) continue;
      // Binary-search-free walk: find the line span the comment touches.
      for (let i = 0; i < lines.length; i++) {
        const ls = lineStarts[i];
        const le = ls + lines[i].length; // exclusive of the newline
        if (le <= c.start) continue;
        if (ls >= c.end) break;
        const start = Math.max(c.start, ls) - ls;
        const end = Math.min(c.end, le) - ls;
        if (end <= start) continue;
        const arr = map.get(i) ?? [];
        arr.push({ start, end, ids: [c.id] });
        map.set(i, arr);
      }
    }
    return map;
  }, [comments, lines, lineStarts]);

  const resolve = useCallback(
    (range: Range) => {
      const container = containerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer))
        return null;
      const startCell = cellOf(range.startContainer);
      const endCell = cellOf(range.endContainer);
      if (!startCell || !endCell) return null;
      const startBase = Number(startCell.dataset.lineStart);
      const endBase = Number(endCell.dataset.lineStart);
      if (Number.isNaN(startBase) || Number.isNaN(endBase)) return null;
      const start =
        startBase +
        offsetWithinCell(startCell, range.startContainer, range.startOffset);
      const end =
        endBase +
        offsetWithinCell(endCell, range.endContainer, range.endOffset);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (hi <= lo) return null;
      return { data: { start: lo, end: hi }, selectedText: text.slice(lo, hi) };
    },
    [text],
  );

  const onCreate = useCallback(
    (
      data: { start: number; end: number },
      selectedText: string,
      comment: string,
    ) => {
      onAddComment?.(data.start, data.end, selectedText, comment);
    },
    [onAddComment],
  );

  const { pending, submit, cancel } = useCommentSelection<{
    start: number;
    end: number;
  }>({
    enabled: !!onAddComment,
    resolve,
    onCreate,
  });

  // Reserve `digits` worth of ch for the number PLUS the px-3 padding. The box
  // is border-box, so width must include padding or the number overflows into
  // the code cell (the tabular digits collide with line 1's text).
  const digits = Math.max(2, String(lines.length).length);
  const gutterWidth = `calc(${digits}ch + 1.5rem)`;
  const lineHeight = Math.round(fontSize * 1.55);

  return (
    <div
      ref={containerRef}
      className="overflow-auto rounded-lg border font-[family-name:var(--font-mono)]"
      style={{
        background: "var(--bg-surface)",
        borderColor: "var(--border)",
        fontSize,
        lineHeight: `${lineHeight}px`,
      }}
    >
      {/* When not wrapping, the content grows to the widest line so the
          container scrolls horizontally; min-w-full keeps short docs full. */}
      <div className={`py-2 ${lineWrap ? "" : "w-max min-w-full"}`}>
        {lines.map((lineText, i) => {
          const segments = buildSegments(
            lineText,
            perLineTokens[i] ?? [],
            rangesByLine.get(i) ?? [],
          );
          return (
            <div key={i} className="flex">
              <div
                className="sticky left-0 z-10 shrink-0 select-none px-3 text-right tabular-nums"
                style={{
                  width: gutterWidth,
                  color: "var(--text-tertiary)",
                  background: "var(--bg-surface)",
                }}
              >
                {i + 1}
              </div>
              <div
                data-line-start={lineStarts[i]}
                className={
                  lineWrap
                    ? "min-w-0 flex-1 whitespace-pre-wrap break-words pr-4"
                    : "whitespace-pre pr-4"
                }
                style={{ color: "var(--text)" }}
              >
                {segments.length === 0
                  ? "\n"
                  : segments.map((seg, si) => {
                      const commented = seg.commentIds.length > 0;
                      const isActive =
                        activeCommentId != null &&
                        seg.commentIds.includes(activeCommentId);
                      return (
                        <span
                          key={si}
                          onClick={
                            commented
                              ? () => onActiveCommentChange?.(seg.commentIds[0])
                              : undefined
                          }
                          style={{
                            color: seg.color,
                            fontStyle: seg.italic ? "italic" : undefined,
                            fontWeight: seg.bold ? 600 : undefined,
                            cursor: commented ? "pointer" : undefined,
                            background: isActive
                              ? "var(--selection-bg)"
                              : commented
                                ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                                : undefined,
                            borderBottom: commented
                              ? "1.5px solid var(--accent)"
                              : undefined,
                          }}
                        >
                          {seg.text}
                        </span>
                      );
                    })}
              </div>
            </div>
          );
        })}
      </div>

      {pending && (
        <CommentPopover
          position={pending.position}
          selectedText={pending.selectedText}
          onSubmit={submit}
          onClose={cancel}
        />
      )}
    </div>
  );
}
