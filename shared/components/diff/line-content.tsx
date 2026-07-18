"use client";

import { memo, type ReactNode } from "react";
import type { DiffLine, WordSegment } from "../../lib/diff";
import type { SyntaxToken } from "../../lib/highlight";

/* ── Per-line content (memoized) ──────────────────────────────
 * One source line's rendered spans. A memoized component so the frequent
 * transient re-renders of the whole diff — mouse-move hunk hover, the merge
 * overlay, comment editing, find stepping — DON'T rebuild every line's spans.
 * A line only re-renders when its own inputs change (its syntax tokens, its
 * overlapping highlights, or — if it carries an annotation — the hovered
 * annotation). The shared EMPTY_* constants keep the common "no decorations"
 * line referentially stable so it bails out of every re-render. */

/** One highlight range within a line, in line-local character offsets. */
export type Hl = {
  s: number;
  e: number;
  kind: "ann" | "pending" | "find" | "find-current";
  annId?: string;
};

/** Stable empty refs — pass these (never fresh `[]`) so undecorated lines
 *  bail out of the memo. */
export const EMPTY_TOKENS: SyntaxToken[] = [];
export const EMPTY_HLS: Hl[] = [];

export interface LineContentProps {
  text: string;
  lineType: DiffLine["type"];
  /** Syntax tokens for this line (a stable ref; EMPTY_TOKENS when none). */
  syntax: SyntaxToken[];
  /** Word-diff segments, or null when this line has none / is whitespace-only. */
  wordSegments: WordSegment[] | null;
  /** Annotation / pending-selection / find highlights (EMPTY_HLS when none). */
  hls: Hl[];
  hoveredAnnId: string | null;
  onClickAnn: (annId: string, rect: DOMRect) => void;
  onHoverAnn: (annId: string | null) => void;
}

function lineContentEqual(a: LineContentProps, b: LineContentProps): boolean {
  if (
    a.text !== b.text ||
    a.lineType !== b.lineType ||
    a.syntax !== b.syntax ||
    a.wordSegments !== b.wordSegments ||
    a.hls !== b.hls ||
    a.onClickAnn !== b.onClickAnn ||
    a.onHoverAnn !== b.onHoverAnn
  ) {
    return false;
  }
  // hoveredAnnId only changes the paint of a line that carries an annotation.
  if (
    b.hls.some((h) => h.kind === "ann") &&
    a.hoveredAnnId !== b.hoveredAnnId
  ) {
    return false;
  }
  return true;
}

export const LineContent = memo(function LineContent({
  text,
  lineType,
  syntax,
  wordSegments,
  hls,
  hoveredAnnId,
  onClickAnn,
  onHoverAnn,
}: LineContentProps): ReactNode {
  if (!text) return " ";

  const wordBgVar =
    lineType === "add"
      ? "var(--diff-add-word)"
      : lineType === "remove"
        ? "var(--diff-remove-word)"
        : null;

  if (hls.length === 0 && syntax.length === 0 && !wordSegments) {
    return text;
  }

  // Build flat list of breakpoints (every range start/end), then walk segments.
  const bounds = new Set<number>([0, text.length]);
  for (const t of syntax) {
    bounds.add(t.start);
    bounds.add(t.end);
  }
  if (wordSegments) {
    let off = 0;
    for (const w of wordSegments) {
      bounds.add(off);
      off += w.text.length;
      bounds.add(off);
    }
  }
  for (const h of hls) {
    bounds.add(h.s);
    bounds.add(h.e);
  }
  const sorted = [...bounds]
    .filter((b) => b >= 0 && b <= text.length)
    .sort((a, b) => a - b);

  // Pre-index word-segment offsets so we can look up per char.
  const wordOffsets: { start: number; end: number; changed: boolean }[] = [];
  if (wordSegments) {
    let off = 0;
    for (const w of wordSegments) {
      wordOffsets.push({
        start: off,
        end: off + w.text.length,
        changed: w.changed,
      });
      off += w.text.length;
    }
  }

  function findSyntax(pos: number) {
    for (const t of syntax) if (t.start <= pos && pos < t.end) return t;
    return null;
  }
  function findAnn(pos: number) {
    for (const h of hls) if (h.s <= pos && pos < h.e) return h;
    return null;
  }
  function findWord(pos: number) {
    for (const w of wordOffsets) if (w.start <= pos && pos < w.end) return w;
    return null;
  }

  const parts: ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (s >= e) continue;
    const slice = text.slice(s, e);

    const synTok = findSyntax(s);
    const annHl = findAnn(s);
    const wordSeg = findWord(s);

    const isAnn = annHl?.kind === "ann";
    const isPending = annHl?.kind === "pending";
    const isFind = annHl?.kind === "find";
    const isFindCurrent = annHl?.kind === "find-current";
    const hovered = isAnn && hoveredAnnId === annHl?.annId;

    const wantsBg =
      isAnn ||
      isPending ||
      isFind ||
      isFindCurrent ||
      (wordSeg && wordSeg.changed);
    const background = isFindCurrent
      ? "var(--find-current-bg, rgba(249,115,22,0.6))"
      : isFind
        ? "var(--find-match-bg, rgba(234,179,8,0.32))"
        : hovered
          ? "var(--highlight-bg-hover)"
          : isAnn
            ? "var(--highlight-bg)"
            : isPending
              ? "var(--selection-bg)"
              : wordSeg && wordSeg.changed && wordBgVar
                ? wordBgVar
                : undefined;

    const classNames: string[] = [];
    if (synTok?.className) classNames.push(synTok.className);
    if (synTok?.color) classNames.push("shiki-tok");
    // Characters that actually changed sit on a tinted pill. The tint lightens
    // the backdrop, which guts the contrast of already-muted tokens (comments
    // are the worst case) — so lift their colour to keep them legible. See
    // `.diff-word` in highlight.css.
    if (wordSeg?.changed) classNames.push("diff-word");
    // Round only the discrete word-diff pills. A range highlight (selection,
    // annotation, find) spans many syntax-token segments, so rounding each one
    // scallops the highlight into separate boxes with gaps — it must read as a
    // single continuous bar (square edges, like a native text selection).
    const isRangeHl = isAnn || isPending || isFind || isFindCurrent;
    if (wantsBg && !isRangeHl) classNames.push("rounded-sm");
    if (isAnn)
      classNames.push(
        "cursor-pointer",
        "border-b-[1.5px]",
        "border-[var(--text-tertiary)]",
      );

    const style: React.CSSProperties & Record<string, string | undefined> = {};
    if (background) style.background = background;
    if (isFindCurrent)
      style.outline = "1px solid var(--find-current-border, #f59e0b)";
    if (synTok?.color) style["--shiki-color"] = synTok.color;
    if (synTok?.italic) style.fontStyle = "italic";
    if (synTok?.bold) style.fontWeight = "600";

    const annId = isAnn ? annHl?.annId : undefined;

    parts.push(
      <span
        key={`p${s}`}
        className={classNames.join(" ") || undefined}
        style={Object.keys(style).length > 0 ? style : undefined}
        onClick={
          isAnn && annId
            ? (event) => {
                event.stopPropagation();
                onClickAnn(
                  annId,
                  (event.currentTarget as HTMLElement).getBoundingClientRect(),
                );
              }
            : undefined
        }
        onMouseEnter={isAnn && annId ? () => onHoverAnn(annId) : undefined}
        onMouseLeave={isAnn ? () => onHoverAnn(null) : undefined}
      >
        {slice}
      </span>,
    );
  }
  return <>{parts}</>;
}, lineContentEqual);
