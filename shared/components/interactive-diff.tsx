"use client";

import {
  memo,
  useRef,
  useState,
  useMemo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  Fragment,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "../lib/store";
import { type DiffSettings, FONT_SIZE_OPTIONS } from "../lib/settings";
import {
  type DiffLine,
  type FilteredItem,
  type SplitRow,
  type WordSegment,
  buildDiffLines,
  filterUnchangedLines,
  buildSplitRows,
  getDiffLineForOffset,
} from "../lib/diff";
import {
  type Change,
  applyChangeLeftToRight,
  applyChangeRightToLeft,
  buildLineToChangeMap,
  computeChanges,
} from "../lib/diff-merge";
import type { GitHunk } from "../lib/git-hunks";
import { highlightPerLine, type SyntaxToken } from "../lib/highlight";
import {
  SYNC_HIGHLIGHT_MAX_CHARS,
  useActiveShikiTheme,
  useShikiReady,
} from "../lib/shiki";
import { computeFoldRanges } from "../lib/folding";
import { useCommentSelection } from "../lib/use-comment-selection";
import { useTextFind } from "../lib/use-text-find";
import { CommentPopover } from "./comment-popover";
import { FindWidget } from "./find-widget";

/* ── Constants ────────────────────────────────────────────── */

// Stable empty per-line token array used while highlighting is deferred.
const EMPTY_LINE_TOKENS: SyntaxToken[][] = [];
// Stable empty list for the searchable visible-line set while find is closed.
const EMPTY_VISIBLE_LINES: DiffLine[] = [];
const LINE_HEIGHT_PX = 22;
const SEPARATOR_HEIGHT_PX = 32;
const COMMENT_TRUNCATE_LEN = 55;
const INLINE_COMMENT_ROW_HEIGHT_PX = 32;
const POPOVER_VIEWPORT_PAD = 380;
const NUM_DIGIT_WIDTH = 8;
const NUM_COL_PAD = 12;
const BAR_WIDTH_PX = 3;
const GUTTER_FONT_SIZE = 11;

/* ── Types ────────────────────────────────────────────────── */

/** Surface-specific anchor for a diff comment: a char range + which side. */
interface DiffAnchor {
  startOffset: number;
  endOffset: number;
  side: "left" | "right";
}

interface EditingAnn {
  annotation: Annotation;
  pos: { top: number; left: number };
}

interface Props {
  oldText: string;
  newText: string;
  settings: DiffSettings;
  onSettingsChange?: (patch: Partial<DiffSettings>) => void;
  isFirstVersion?: boolean;
  /** Language id (see LANGUAGES in shared/lib/highlight). "auto"/"plaintext" disables coloring. */
  language?: string;
  annotations?: Annotation[];
  onAddAnnotation?: (
    sel: string,
    start: number,
    end: number,
    comment: string,
    side: "left" | "right"
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
  /**
   * Opt-in merge UI. When provided, each change becomes interactive: a small
   * "merge" affordance appears in the gutter; clicking it lifts a floating
   * card with two directional Merge buttons. The handler receives the next
   * left/right text after the merge is applied.
   */
  onMergeChange?: (next: { left: string; right: string }) => void;
  /**
   * Opt-in VS Code-style per-hunk staging. When provided, hovering a change
   * block reveals Stage/Revert (or Unstage) controls. Handlers receive the
   * block's 1-based line range so the caller can match it to a git hunk.
   */
  hunkActions?: {
    isStaged: boolean;
    /** The file's git hunks (the real stageable unit). The split-view gutter
     *  renders one control box per hunk, so a click stages exactly that hunk. */
    hunks: GitHunk[];
    onStage: (range: HunkRange) => void;
    onRevert: (range: HunkRange) => void;
    onUnstage: (range: HunkRange) => void;
  };
  /**
   * Enable the in-view ⌘F find widget. Default true. Set false when several
   * diffs are mounted at once (e.g. hidden desktop tabs) so only the visible one
   * responds to ⌘F.
   */
  findEnabled?: boolean;
  /**
   * How the diff-settings controls are presented. "bar" (default) lays them out
   * inline above the diff — the web surface. "popover" collapses them behind a
   * single gear button that opens a small panel — the desktop surface, where the
   * header is already crowded with file actions.
   */
  settingsVariant?: "bar" | "popover";
  /**
   * Where to render the "popover" gear button. When provided, the gear is
   * portaled into this node (e.g. a slot in the file header beside "Format")
   * instead of sitting above the diff — while its logic stays here, so the
   * "Changes only" toggle keeps tracking manual line expansions. Ignored unless
   * settingsVariant is "popover".
   */
  settingsPortalTarget?: HTMLElement | null;
}

export interface HunkRange {
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

/* ── Style helpers ────────────────────────────────────────── */

/** Fold toggle chevron: points down when open, right when collapsed. */
function FoldChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: collapsed ? "rotate(-90deg)" : "none",
        transition: "transform 120ms",
      }}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function visualType(line: DiffLine): DiffLine["type"] {
  return line.whitespaceOnly ? "context" : line.type;
}

/**
 * Indentation fold ranges over a sequence of displayed rows. Each row carries
 * its text and a stable `key` (a DiffLine.idx; −1 for non-foldable rows such as
 * separators). For the given collapse set it returns which row indices begin a
 * fold and which rows are hidden. Folding whole rows (not diff lines) keeps the
 * split panes aligned — a hidden row drops from both columns together.
 */
function computeRowFolds(
  rows: { content: string; key: number }[],
  collapsed: Set<number>
): {
  startByRow: Map<number, { end: number; key: number }>;
  hidden: Set<number>;
} {
  const ranges = computeFoldRanges(rows.map((r) => r.content));
  const startByRow = new Map<number, { end: number; key: number }>();
  const hidden = new Set<number>();
  for (const r of ranges) {
    const key = rows[r.start]?.key ?? -1;
    if (key < 0) continue; // separators never begin a fold
    startByRow.set(r.start, { end: r.end, key });
    if (collapsed.has(key)) {
      for (let i = r.start + 1; i <= r.end; i++) hidden.add(i);
    }
  }
  return { startByRow, hidden };
}

function barColor(type: DiffLine["type"]) {
  if (type === "add") return "var(--diff-add-bar)";
  if (type === "remove") return "var(--diff-remove-bar)";
  return "transparent";
}

function lineBg(type: DiffLine["type"]) {
  if (type === "add") return "var(--diff-add-bg)";
  if (type === "remove") return "var(--diff-remove-bg)";
  return undefined;
}

function gutterBg(type: DiffLine["type"]) {
  if (type === "add") return "var(--diff-add-gutter)";
  if (type === "remove") return "var(--diff-remove-gutter)";
  return undefined;
}

/** Nearest scrollable ancestor (the element the diff actually scrolls inside). */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/** One git hunk mapped to its changed-line extent + the range that stages it. */
interface HunkBlock {
  hunkIdx: number;
  /** dLines index of the first changed line in the hunk. */
  firstIdx: number;
  /** dLines index of the last changed line in the hunk. */
  lastIdx: number;
  range: HunkRange;
}

/* ── Merge overlay (lifted card over a change) ────────────── */

interface MergeOverlayProps {
  top: number;
  height: number;
  currentIdx: number;
  totalChanges: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onApplyLeftToRight: () => void;
  onApplyRightToLeft: () => void;
}

/** Header/footer strip heights — kept narrow so the overlay barely intrudes. */
const STRIP_H = 26;

function MergeOverlay({
  top,
  height,
  currentIdx,
  totalChanges,
  onClose,
  onPrev,
  onNext,
  onApplyLeftToRight,
  onApplyRightToLeft,
}: MergeOverlayProps) {
  // Total absolute slot: a thin strip ABOVE the change + the change rows
  // themselves (transparent middle, the diff lines beneath show through) + a
  // thin strip BELOW. Strips overlap whatever context row was immediately
  // adjacent to the change.
  return (
    <div
      data-merge-overlay
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ top: top - STRIP_H, height: height + STRIP_H * 2 }}
    >
      {/* Frame: just a ring around the whole slot, no background */}
      <div className="pointer-events-none absolute inset-x-2 inset-y-0 rounded-md shadow-[0_6px_18px_rgba(0,0,0,0.18)] ring-2 ring-[var(--accent)]" />

      {/* Header strip (above the change) */}
      <div
        className="pointer-events-auto absolute inset-x-2 top-0 flex items-center justify-between gap-2 rounded-t-md border-b border-[var(--accent)]/30 bg-[var(--bg-surface)] px-2"
        style={{ height: STRIP_H }}
      >
        <div className="flex items-center gap-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
          <span>
            Change {currentIdx + 1}{" "}
            <span className="text-[var(--text-tertiary)]">of {totalChanges}</span>
          </span>
          <button
            onClick={onPrev}
            className="ml-2 rounded px-1.5 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
            aria-label="Previous change"
            title="Previous change"
          >
            ↑
          </button>
          <button
            onClick={onNext}
            className="rounded px-1.5 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
            aria-label="Next change"
            title="Next change"
          >
            ↓
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-[16px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {/* Footer strip (below the change). Each button sits on its own side and
          its arrow points the way the change is copied: the left button takes
          the LEFT version and applies it to the RIGHT (→); the right button
          takes the RIGHT version and applies it to the LEFT (←). */}
      <div
        className="pointer-events-auto absolute inset-x-2 bottom-0 flex items-center justify-between gap-3 rounded-b-md border-t border-[var(--accent)]/30 bg-[var(--bg-surface)] px-2"
        style={{ height: STRIP_H }}
      >
        <button
          onClick={onApplyLeftToRight}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--diff-add-bar)] px-2.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          title="Copy the left side's version to the right"
        >
          <span>Merge</span>
          <span aria-hidden>→</span>
        </button>
        <button
          onClick={onApplyRightToLeft}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--diff-remove-bar)] px-2.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          title="Copy the right side's version to the left"
        >
          <span aria-hidden>←</span>
          <span>Merge</span>
        </button>
      </div>
    </div>
  );
}

/* ── Component ────────────────────────────────────────────── */

/* ── Per-line content (memoized) ──────────────────────────────
 * One source line's rendered spans. Extracted into a memoized component so the
 * frequent transient re-renders of the whole diff — mouse-move hunk hover, the
 * merge overlay, comment editing, find stepping — DON'T rebuild every line's
 * spans. A line only re-renders when its own inputs change (its syntax tokens,
 * its overlapping highlights, or — if it carries an annotation — the hovered
 * annotation). The shared EMPTY_* constants keep the common "no decorations"
 * line referentially stable so it bails out of every re-render. */

type Hl = {
  s: number;
  e: number;
  kind: "ann" | "pending" | "find" | "find-current";
  annId?: string;
};

const EMPTY_TOKENS: SyntaxToken[] = [];
const EMPTY_HLS: Hl[] = [];

interface LineContentProps {
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
  if (b.hls.some((h) => h.kind === "ann") && a.hoveredAnnId !== b.hoveredAnnId) {
    return false;
  }
  return true;
}

const LineContent = memo(function LineContent({
  text,
  lineType,
  syntax,
  wordSegments,
  hls,
  hoveredAnnId,
  onClickAnn,
  onHoverAnn,
}: LineContentProps): ReactNode {
  if (!text) return " ";

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
      wordOffsets.push({ start: off, end: off + w.text.length, changed: w.changed });
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
      isAnn || isPending || isFind || isFindCurrent || (wordSeg && wordSeg.changed);
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
        "border-[var(--text-tertiary)]"
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
                  (event.currentTarget as HTMLElement).getBoundingClientRect()
                );
              }
            : undefined
        }
        onMouseEnter={isAnn && annId ? () => onHoverAnn(annId) : undefined}
        onMouseLeave={isAnn ? () => onHoverAnn(null) : undefined}
      >
        {slice}
      </span>
    );
  }
  return <>{parts}</>;
}, lineContentEqual);

export function InteractiveDiff({
  oldText,
  newText,
  settings,
  onSettingsChange,
  isFirstVersion = false,
  language = "plaintext",
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onMergeChange,
  hunkActions,
  findEnabled = true,
  settingsVariant = "bar",
  settingsPortalTarget,
}: Props) {
  const mergeEnabled = !!onMergeChange;
  const hunkActionsEnabled = !!hunkActions;
  const contentRef = useRef<HTMLDivElement>(null);
  // Split-view column wrappers — used to lock a text selection to the side it
  // started in (the two versions are separate tables, so a native drag-select
  // would otherwise bleed into the other version's aligned lines).
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  // Unified view's single editable region (its split-view counterparts are the
  // two column refs above). Holds the caret so ⌘A scopes to the diff text.
  const unifiedRef = useRef<HTMLDivElement>(null);
  const [hoveredAnnId, setHoveredAnnId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingAnn | null>(null);
  const [expandedSeparators, setExpandedSeparators] = useState<Set<number>>(
    new Set()
  );
  // Start lines (DiffLine.idx) of the regions the user has collapsed.
  const [collapsedFolds, setCollapsedFolds] = useState<Set<number>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Dismiss the settings popover on any click outside it (incl. the trigger).
  useEffect(() => {
    if (!settingsOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!settingsRef.current?.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [settingsOpen]);

  const interactive = !!onAddAnnotation;
  const effectiveViewMode = isFirstVersion ? "unified" : settings.viewMode;

  useEffect(() => {
    setExpandedSeparators(new Set());
  }, [oldText, newText, settings.hideUnchanged]);

  /* ── Diff computation ───────────────────────────────────── */

  const dLines = useMemo(
    () => buildDiffLines(oldText, newText, settings.ignoreWhitespace),
    [oldText, newText, settings.ignoreWhitespace]
  );

  /* ── Code folding (indentation regions, folded by visual row) ────── */
  //
  // Folds are computed over each view's *displayed rows* and hide whole rows. In
  // split view a row is a left/right pair, so hiding it collapses both panes
  // together and they stay aligned — folding at the diff-line level (then
  // re-pairing the split rows) desynced the panes. Uses the indentation model
  // directly, not the tree-sitter engine: a diff interleaves old/new content
  // that no parser can read; indentation folding is line-based and handles it.
  // Collapsed state is keyed by the representative DiffLine.idx of a fold's start
  // row, so a fold survives switching between unified and split.

  const toggleFold = useCallback((key: number) => {
    setCollapsedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // A real change to the texts invalidates the old fold starts entirely.
  useEffect(() => {
    setCollapsedFolds(new Set());
  }, [dLines]);

  const filtered: FilteredItem[] = useMemo(() => {
    if (!settings.hideUnchanged) return dLines;
    return filterUnchangedLines(dLines);
  }, [dLines, settings.hideUnchanged]);

  const expandedFiltered: FilteredItem[] = useMemo(() => {
    if (expandedSeparators.size === 0) return filtered;
    const result: FilteredItem[] = [];
    let sepIdx = 0;
    let linesSoFar = 0;
    for (const item of filtered) {
      if (item.type === "separator") {
        if (expandedSeparators.has(sepIdx)) {
          for (let j = 0; j < item.hiddenCount; j++) {
            result.push(dLines[linesSoFar + j]);
          }
        } else {
          result.push(item);
        }
        linesSoFar += item.hiddenCount;
        sepIdx++;
      } else {
        result.push(item);
        linesSoFar++;
      }
    }
    return result;
  }, [filtered, expandedSeparators, dLines]);

  const splitRows: SplitRow[] = useMemo(
    () => buildSplitRows(expandedFiltered),
    [expandedFiltered]
  );

  // Per-view fold ranges over the displayed rows: which rows begin a fold and
  // which rows are hidden by the current collapse set. `key` is the row's
  // representative DiffLine.idx (−1 for separators, which never begin a fold).
  const unifiedFold = useMemo(
    () =>
      computeRowFolds(
        expandedFiltered.map((it) =>
          it.type === "separator"
            ? { content: "", key: -1 }
            : { content: it.content, key: it.idx }
        ),
        collapsedFolds
      ),
    [expandedFiltered, collapsedFolds]
  );
  const splitFold = useMemo(
    () =>
      computeRowFolds(
        splitRows.map((row) => {
          if (row.type === "separator") return { content: "", key: -1 };
          const rep = row.right ?? row.left;
          return { content: rep?.content ?? "", key: rep?.idx ?? -1 };
        }),
        collapsedFolds
      ),
    [splitRows, collapsedFolds]
  );

  /* ── In-view find (⌘F) ─────────────────────────────────────── */

  // Only currently-visible lines are searchable: hidden regions ("N unchanged
  // lines") and collapsed separators are excluded until the user expands them.
  // The searchable text is each visible line's content, newline-joined; the
  // provider runs lazily (only while find is open) so expand/collapse and
  // "show only changes" cost nothing when nobody is searching. Opening find — or
  // revealing/hiding lines while it's open — changes expandedFiltered, so the
  // match list and the widget's count recompute the moment the view changes.
  const buildFindText = useCallback(() => {
    const parts: string[] = [];
    for (const it of expandedFiltered) {
      if (it.type !== "separator") parts.push(it.content);
    }
    return parts.join("\n");
  }, [expandedFiltered]);

  const find = useTextFind(buildFindText);
  const [findReveal, setFindReveal] = useState(0);

  // Visible lines + their offsets back the match→row mapping below. Both are
  // gated on find.open (empty otherwise) so they cost nothing until searching,
  // and both walk expandedFiltered skipping separators in the same order as
  // buildFindText, so offsets line up exactly. `findLineStarts[i]` is
  // visibleLines[i]'s start offset in the searchable text.
  const visibleLines = useMemo(
    () =>
      find.open
        ? expandedFiltered.filter(
            (it): it is DiffLine => it.type !== "separator"
          )
        : EMPTY_VISIBLE_LINES,
    [find.open, expandedFiltered]
  );
  const findLineStarts = useMemo(() => {
    const arr = new Array<number>(visibleLines.length);
    let acc = 0;
    for (let i = 0; i < visibleLines.length; i++) {
      arr[i] = acc;
      acc += visibleLines[i].content.length + 1;
    }
    return arr;
  }, [visibleLines]);

  const findLineOfOffset = useCallback(
    (offset: number): number => {
      let lo = 0;
      let hi = findLineStarts.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (findLineStarts[mid] <= offset) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    },
    [findLineStarts]
  );

  // dLines index → its find matches as line-local ranges, each tagged with its
  // global match index `i`. Match offsets index into visibleLines; map each back
  // to its dLines `idx`, which is the key rendering looks up (and the data-dline
  // used for scrolling). Deliberately independent of find.current: stepping
  // next/prev only moves the cursor, so this map stays referentially stable and
  // the active match is resolved at render time by comparing `i` to find.current.
  const findByLine = useMemo(() => {
    const map = new Map<number, { s: number; e: number; i: number }[]>();
    if (!find.open) return map;
    for (let i = 0; i < find.matches.length; i++) {
      const m = find.matches[i];
      const vi = findLineOfOffset(m.start);
      const line = visibleLines[vi];
      if (!line) continue;
      const ls = findLineStarts[vi];
      const contentLen = line.content.length;
      const entry = {
        s: m.start - ls,
        e: Math.min(m.end - ls, contentLen),
        i,
      };
      const arr = map.get(line.idx);
      if (arr) arr.push(entry);
      else map.set(line.idx, [entry]);
    }
    return map;
  }, [find.open, find.matches, findLineStarts, findLineOfOffset, visibleLines]);

  // ⌘F opens the find widget for this diff (seeded with any selection).
  useEffect(() => {
    if (!findEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        const sel = window.getSelection()?.toString() ?? "";
        find.show(sel && sel.length <= 200 && !sel.includes("\n") ? sel : undefined);
        setFindReveal((n) => n + 1);
      } else if (e.key === "Escape" && find.open) {
        find.close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [findEnabled, find]);

  // Scroll the active match into view as the user steps through (not virtualized,
  // so locate its row by data-dline and let the browser scroll it centered).
  useEffect(() => {
    if (!find.open || find.current < 0) return;
    const m = find.matches[find.current];
    if (!m) return;
    const li = visibleLines[findLineOfOffset(m.start)]?.idx;
    if (li == null) return;
    const el = contentRef.current?.querySelector(`[data-dline="${li}"]`);
    el?.scrollIntoView({ block: "center", behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.current, find.matches]);

  /* ── Syntax highlighting (per source line) ─────────────────── */

  // Triggers re-render once shiki finishes loading so first-paint tokens
  // (which were empty) get replaced with colored ones.
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  // Tokenizing both sides is a synchronous main-thread cost. For small/medium
  // diffs it's sub-frame, so we tokenize on the urgent (open) render and the
  // diff appears already colored — no flash of plain text. Only large diffs
  // defer: they paint instantly without colors, then a low-priority render fills
  // them in so a huge diff never freezes the pane. `tokensStale` keeps the
  // previous file's tokens off the new rows during the lagging frame.
  const deferredOld = useDeferredValue(oldText);
  const deferredNew = useDeferredValue(newText);
  const tokensStale =
    oldText.length + newText.length > SYNC_HIGHLIGHT_MAX_CHARS &&
    (deferredOld !== oldText || deferredNew !== newText);
  const oldLineTokens = useMemo(
    () => (tokensStale ? EMPTY_LINE_TOKENS : highlightPerLine(oldText, language)),
    // shikiReady / shikiTheme are deps so the memo invalidates when the
    // highlighter becomes ready and re-tokenizes when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oldText, tokensStale, language, shikiReady, shikiTheme]
  );
  const newLineTokens = useMemo(
    () => (tokensStale ? EMPTY_LINE_TOKENS : highlightPerLine(newText, language)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newText, tokensStale, language, shikiReady, shikiTheme]
  );

  function tokensForDiffLine(line: DiffLine): SyntaxToken[] {
    // Returning a shared empty constant (not `?? []`) keeps the token ref stable
    // across renders, so a line with no tokens bails out of LineContent's memo.
    if (line.type === "remove") {
      return oldLineTokens[(line.oldNum ?? 0) - 1] ?? EMPTY_TOKENS;
    }
    return newLineTokens[(line.newNum ?? 0) - 1] ?? EMPTY_TOKENS;
  }

  /* ── Change blocks (for the merge overlay) ─────────────── */

  const blocksEnabled = mergeEnabled || hunkActionsEnabled;
  const changes: Change[] = useMemo(
    () => (blocksEnabled ? computeChanges(dLines) : []),
    [dLines, blocksEnabled]
  );
  const lineToChange = useMemo(
    () => (blocksEnabled ? buildLineToChangeMap(changes) : new Map<number, number>()),
    [changes, blocksEnabled]
  );

  /* ── Split-view per-hunk gutter (VS Code-style stage/revert) ── */

  // `hunkActions.hunks` is memoized by the caller, so depend on the array (not
  // the inline `hunkActions` object, which is a fresh literal every render).
  const hunkList = hunkActions?.hunks;

  // Each git hunk → its first/last changed line in `dLines` + the range that
  // stages exactly it. Git hunks (not finer `Change`s) are the stageable unit,
  // so one box per hunk means a click can never stage a neighbour.
  const hunkBlocks: HunkBlock[] = useMemo(() => {
    if (!hunkActionsEnabled || !hunkList?.length) return [];
    // One pass instead of (hunks × lines): build sorted hunk extents per side,
    // then walk dLines once, binary-searching each changed line to its hunk.
    // Old O(n×m) re-scanned every line for every hunk — 200k+ comparisons on a
    // big file with many hunks, synchronously on each diff open.
    const oldRanges = hunkList.map((h) => ({
      start: h.oldStart,
      end: h.oldStart + Math.max(h.oldCount, 1) - 1,
    }));
    const newRanges = hunkList.map((h) => ({
      start: h.newStart,
      end: h.newStart + Math.max(h.newCount, 1) - 1,
    }));
    const findHunk = (
      ranges: { start: number; end: number }[],
      n: number
    ): number => {
      let lo = 0;
      let hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (n < ranges[mid].start) hi = mid - 1;
        else if (n > ranges[mid].end) lo = mid + 1;
        else return mid;
      }
      return -1;
    };
    const first = new Array<number>(hunkList.length).fill(Infinity);
    const last = new Array<number>(hunkList.length).fill(-Infinity);
    for (const l of dLines) {
      let hunkIdx = -1;
      if (l.type === "remove" && l.oldNum != null) {
        hunkIdx = findHunk(oldRanges, l.oldNum);
      } else if (l.type === "add" && l.newNum != null) {
        hunkIdx = findHunk(newRanges, l.newNum);
      }
      if (hunkIdx === -1) continue;
      if (l.idx < first[hunkIdx]) first[hunkIdx] = l.idx;
      if (l.idx > last[hunkIdx]) last[hunkIdx] = l.idx;
    }
    const out: HunkBlock[] = [];
    hunkList.forEach((h, hunkIdx) => {
      if (first[hunkIdx] === Infinity) return; // hunk with no changed lines
      out.push({
        hunkIdx,
        firstIdx: first[hunkIdx],
        lastIdx: last[hunkIdx],
        range: {
          oldStart: h.oldCount > 0 ? h.oldStart : null,
          oldEnd: h.oldCount > 0 ? oldRanges[hunkIdx].end : null,
          newStart: h.newCount > 0 ? h.newStart : null,
          newEnd: h.newCount > 0 ? newRanges[hunkIdx].end : null,
        },
      });
    });
    return out;
  }, [hunkActionsEnabled, hunkList, dLines]);

  const showGutter =
    hunkActionsEnabled && effectiveViewMode === "split" && hunkBlocks.length > 0;

  const gutterRef = useRef<HTMLDivElement>(null);
  const hunkBoxRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const hunkLineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Cached pixel extent (top/bottom in gutter-local coords) of each hunk.
  // Measured only on layout changes; the scroll handler reads these, never the
  // DOM — which is why the box can't jitter or drift the way earlier tries did.
  const hunkExtents = useRef<Map<number, { top: number; bottom: number }>>(
    new Map()
  );

  useLayoutEffect(() => {
    if (!showGutter) {
      hunkExtents.current.clear();
      return;
    }
    const content = contentRef.current;
    const gutter = gutterRef.current;
    if (!content || !gutter) return;
    const scrollParent = findScrollParent(gutter);

    // Re-measure each hunk's extent and pin its line. Cheap and rare (layout
    // changes only). Union across both columns so the line spans whichever side
    // wrapped taller — keeping it aligned regardless of line-wrap.
    const measure = () => {
      const gTop = gutter.getBoundingClientRect().top;
      for (const b of hunkBlocks) {
        const firsts = content.querySelectorAll(`[data-dline="${b.firstIdx}"]`);
        const lasts = content.querySelectorAll(`[data-dline="${b.lastIdx}"]`);
        if (!firsts.length || !lasts.length) {
          hunkExtents.current.delete(b.hunkIdx);
          continue;
        }
        let top = Infinity;
        let bottom = -Infinity;
        firsts.forEach((el) => {
          top = Math.min(top, el.getBoundingClientRect().top - gTop);
        });
        lasts.forEach((el) => {
          bottom = Math.max(bottom, el.getBoundingClientRect().bottom - gTop);
        });
        hunkExtents.current.set(b.hunkIdx, { top, bottom });
        const line = hunkLineRefs.current.get(b.hunkIdx);
        if (line) {
          line.style.top = `${top}px`;
          line.style.height = `${Math.max(0, bottom - top)}px`;
        }
      }
      place();
    };

    // Centre each box in the visible slice of its hunk, hard-clamped to the
    // hunk so it can never bleed into a neighbour. Pure arithmetic on cached
    // extents — no layout, no jitter.
    const place = () => {
      const gTop = gutter.getBoundingClientRect().top;
      let viewTop: number;
      let viewBottom: number;
      if (scrollParent) {
        const r = scrollParent.getBoundingClientRect();
        viewTop = r.top - gTop;
        viewBottom = r.bottom - gTop;
      } else {
        viewTop = -gTop;
        viewBottom = window.innerHeight - gTop;
      }
      // Keep the box clear of the sticky find bar at the top of the viewport.
      viewTop += find.open ? 44 : 6;

      for (const b of hunkBlocks) {
        const box = hunkBoxRefs.current.get(b.hunkIdx);
        const ext = hunkExtents.current.get(b.hunkIdx);
        if (!box || !ext) continue;
        const half = (box.offsetHeight || 32) / 2;
        const visTop = Math.max(ext.top, viewTop);
        const visBottom = Math.min(ext.bottom, viewBottom);
        const center =
          visBottom <= visTop
            ? // Hunk fully off-screen: park at the nearest edge (still clamped).
              ext.top < viewTop
              ? ext.bottom - half
              : ext.top + half
            : (visTop + visBottom) / 2;
        const min = ext.top + half;
        const max = ext.bottom - half;
        box.style.top = `${
          max < min ? (ext.top + ext.bottom) / 2 : Math.min(Math.max(center, min), max)
        }px`;
      }
    };

    measure();

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    const ro = new ResizeObserver(() => measure());
    ro.observe(content);
    const scrollTarget: Window | HTMLElement = scrollParent ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      scrollTarget.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
    };
  }, [
    showGutter,
    hunkBlocks,
    splitRows,
    effectiveViewMode,
    settings.lineWrap,
    settings.fontSize,
    settings.hideUnchanged,
    expandedSeparators,
    find.open,
  ]);

  const [activeChangeIdx, setActiveChangeIdx] = useState<number | null>(null);
  const [overlayPos, setOverlayPos] = useState<
    { top: number; height: number } | null
  >(null);

  // Reset active change whenever the underlying texts change (their change
  // indices are no longer valid).
  useEffect(() => {
    setActiveChangeIdx(null);
    setOverlayPos(null);
  }, [oldText, newText]);

  // Compute overlay position when active change changes (or after a settings
  // change that may have shifted rows around).
  useEffect(() => {
    if (activeChangeIdx === null || !contentRef.current) {
      setOverlayPos(null);
      return;
    }
    const change = changes[activeChangeIdx];
    if (!change) return;
    const root = contentRef.current;
    const startEl = root.querySelector<HTMLElement>(
      `[data-dline="${change.startLineIdx}"]`
    );
    const endEl = root.querySelector<HTMLElement>(
      `[data-dline="${change.endLineIdx}"]`
    );
    if (!startEl || !endEl) return;
    const rootRect = root.getBoundingClientRect();
    const startRect = startEl.getBoundingClientRect();
    const endRect = endEl.getBoundingClientRect();
    setOverlayPos({
      top: startRect.top - rootRect.top,
      height: endRect.bottom - startRect.top,
    });
  }, [activeChangeIdx, changes, settings.viewMode, settings.hideUnchanged, expandedSeparators]);

  // Close overlay on outside click or Escape.
  useEffect(() => {
    if (activeChangeIdx === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setActiveChangeIdx(null);
      }
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      // Click outside the overlay closes it. The overlay sets data attr.
      const overlay = document.querySelector("[data-merge-overlay]");
      if (overlay && overlay.contains(target)) return;
      setActiveChangeIdx(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [activeChangeIdx]);

  const applyMerge = useCallback(
    (direction: "leftToRight" | "rightToLeft") => {
      if (activeChangeIdx === null || !onMergeChange) return;
      const change = changes[activeChangeIdx];
      if (!change) return;
      const next =
        direction === "rightToLeft"
          ? { left: applyChangeRightToLeft(oldText, change, dLines), right: newText }
          : { left: oldText, right: applyChangeLeftToRight(newText, change, dLines) };
      onMergeChange(next);
      setActiveChangeIdx(null);
    },
    [activeChangeIdx, changes, dLines, oldText, newText, onMergeChange]
  );

  const goToChange = useCallback(
    (delta: number) => {
      if (changes.length === 0) return;
      const cur = activeChangeIdx ?? -1;
      const next = (cur + delta + changes.length) % changes.length;
      setActiveChangeIdx(next);
    },
    [changes.length, activeChangeIdx]
  );

  /* ── Inline hunk-staging affordance ─────────────────────── */

  const [hoverChangeIdx, setHoverChangeIdx] = useState<number | null>(null);
  const [hunkCtrlTop, setHunkCtrlTop] = useState<number | null>(null);
  // Split-view: which hunk's box is currently revealed (hover/focus). Only one
  // box is ever shown, so oversized boxes on small hunks can't collide.
  const [hoveredHunkIdx, setHoveredHunkIdx] = useState<number | null>(null);

  useEffect(() => {
    setHoverChangeIdx(null);
    setHoveredHunkIdx(null);
  }, [oldText, newText]);

  // dLines index → the hunk it belongs to, spanning each hunk's full extent
  // (incl. internal context) so hovering anywhere in a block reveals its box.
  const dlineToHunk = useMemo(() => {
    const map = new Map<number, number>();
    for (const b of hunkBlocks) {
      for (let i = b.firstIdx; i <= b.lastIdx; i++) map.set(i, b.hunkIdx);
    }
    return map;
  }, [hunkBlocks]);

  // Resolve a mousemove to a hovered hunk. Returns the hunk idx, `null` to
  // clear, or `undefined` to keep the current hover (cursor is on the box).
  function hunkHoverFromEvent(e: React.MouseEvent): number | null | undefined {
    const target = e.target as HTMLElement;
    const gutter = gutterRef.current;
    // Inside the gutter: the box itself keeps the hover; otherwise resolve by
    // the cursor's Y against the cached hunk extents (so the whole gutter
    // column is hover-active per hunk, making the box easy to reach).
    if (gutter && gutter.contains(target)) {
      if (target.closest("[data-hunk-control]")) return undefined;
      const y = e.clientY - gutter.getBoundingClientRect().top;
      for (const b of hunkBlocks) {
        const ext = hunkExtents.current.get(b.hunkIdx);
        if (ext && y >= ext.top && y <= ext.bottom) return b.hunkIdx;
      }
      return null;
    }
    // Over the code: resolve by the hovered diff row.
    let el: HTMLElement | null = target;
    while (el && !el.hasAttribute("data-dline")) {
      if (el === contentRef.current) return null;
      el = el.parentElement;
    }
    if (!el) return null;
    return dlineToHunk.get(parseInt(el.getAttribute("data-dline")!)) ?? null;
  }

  useEffect(() => {
    if (
      !hunkActionsEnabled ||
      hoverChangeIdx === null ||
      !contentRef.current
    ) {
      setHunkCtrlTop(null);
      return;
    }
    const change = changes[hoverChangeIdx];
    if (!change) return;
    const root = contentRef.current;
    const startEl = root.querySelector<HTMLElement>(
      `[data-dline="${change.startLineIdx}"]`
    );
    if (!startEl) return;
    const endEl =
      root.querySelector<HTMLElement>(`[data-dline="${change.endLineIdx}"]`) ??
      startEl;
    const rootRect = root.getBoundingClientRect();
    const startRect = startEl.getBoundingClientRect();
    const endRect = endEl.getBoundingClientRect();
    // Center the control vertically on the hunk (VS Code-style).
    setHunkCtrlTop((startRect.top + endRect.bottom) / 2 - rootRect.top);
  }, [
    hunkActionsEnabled,
    hoverChangeIdx,
    changes,
    settings.viewMode,
    settings.hideUnchanged,
    expandedSeparators,
  ]);

  const changeRange = useCallback(
    (change: Change): HunkRange => {
      const olds = change.removed
        .map((l) => l.oldNum)
        .filter((n): n is number => typeof n === "number");
      const news = change.added
        .map((l) => l.newNum)
        .filter((n): n is number => typeof n === "number");
      return {
        oldStart: olds.length ? Math.min(...olds) : null,
        oldEnd: olds.length ? Math.max(...olds) : null,
        newStart: news.length ? Math.min(...news) : null,
        newEnd: news.length ? Math.max(...news) : null,
      };
    },
    []
  );

  /* ── Inline comment positions (by end line) ─────────────── */

  const annotationsByEndLine = useMemo(() => {
    const map = new Map<number, { annotation: Annotation; index: number }[]>();
    annotations.forEach((a, i) => {
      const lineIdx = getDiffLineForOffset(
        Math.max(0, a.endOffset - 1),
        dLines
      );
      const existing = map.get(lineIdx) || [];
      existing.push({ annotation: a, index: i });
      map.set(lineIdx, existing);
    });
    return map;
  }, [annotations, dLines]);

  /* ── Line number column width ───────────────────────────── */

  const maxLineNum = dLines.reduce(
    (m, l) => Math.max(m, l.oldNum ?? 0, l.newNum ?? 0),
    0
  );
  const numDigits = Math.max(String(maxLineNum).length, 1);
  const numColW = numDigits * NUM_DIGIT_WIDTH + NUM_COL_PAD;

  /* ── Separator toggle ───────────────────────────────────── */

  const toggleSeparator = useCallback((idx: number) => {
    setExpandedSeparators((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }, []);

  /* ── Offset calculation ─────────────────────────────────── */

  function getAbsoluteOffset(node: Node, nodeOff: number): number {
    if (!contentRef.current) return -1;
    let el: Element | null =
      node instanceof Element ? node : node.parentElement;
    while (el && !el.hasAttribute("data-dline")) {
      if (el === contentRef.current) return -1;
      el = el.parentElement;
    }
    if (!el) return -1;
    const lineIdx = parseInt(el.getAttribute("data-dline")!);
    const line = dLines[lineIdx];
    if (!line) return -1;

    // Characters from the line's start up to the boundary. A Range lets the
    // browser flatten the line's nested span stack (syntax + word-diff +
    // highlight wrappers) and resolve element-node boundaries — a triple-click
    // ends at the *start* of the next line's element, which the old manual
    // text-node walk mis-counted as that whole line's length, bleeding the
    // selection/annotation onto the line below.
    const r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(node, nodeOff);
    return line.flatOffset + r.toString().length;
  }

  /* ── Split-side validation ──────────────────────────────── */

  function findSplitSide(node: Node): string | null {
    let el: Element | null =
      node instanceof Element ? node : node.parentElement;
    while (el && el !== contentRef.current) {
      const side = el.getAttribute("data-split-side");
      if (side) return side;
      el = el.parentElement;
    }
    return null;
  }

  // On mousedown, disable selection on the OTHER column so the drag can't
  // extend into it — keeping the highlight on one version at a time. Released
  // on the next mouseup (below).
  function lockSelectionToStartSide(e: React.MouseEvent) {
    if (effectiveViewMode !== "split") return;
    const side = findSplitSide(e.target as Node);
    if (leftColRef.current)
      leftColRef.current.style.userSelect = side === "right" ? "none" : "";
    if (rightColRef.current)
      rightColRef.current.style.userSelect = side === "left" ? "none" : "";
  }

  useEffect(() => {
    const release = () => {
      if (leftColRef.current) leftColRef.current.style.userSelect = "";
      if (rightColRef.current) rightColRef.current.style.userSelect = "";
    };
    window.addEventListener("mouseup", release);
    return () => window.removeEventListener("mouseup", release);
  }, []);

  /* ── Caret / read-only editing host ─────────────────────────
   * Each side is a `contentEditable` region so it gets a real blinking caret on
   * click and native caret navigation (arrows / shift+arrows to extend a
   * selection), and so ⌘A is scoped by the browser to just that side's text —
   * the centre gutter (stage/revert/unstage controls) and the other column live
   * outside the focused host, so they're never swept into the selection.
   *
   * It must stay strictly read-only: cancel every mutation at the source via the
   * native `beforeinput` event (covers typing, Enter, Backspace/Delete, format
   * shortcuts, IME commits and paste-insertion alike), plus paste/cut/drop. We
   * listen natively (not via React's onBeforeInput) because only the native
   * InputEvent is cancelable across the cases above. */
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    const hosts = [
      leftColRef.current,
      rightColRef.current,
      unifiedRef.current,
    ].filter((el): el is HTMLDivElement => el !== null);
    for (const el of hosts) {
      el.addEventListener("beforeinput", block);
      el.addEventListener("paste", block);
      el.addEventListener("cut", block);
      el.addEventListener("drop", block);
    }
    return () => {
      for (const el of hosts) {
        el.removeEventListener("beforeinput", block);
        el.removeEventListener("paste", block);
        el.removeEventListener("cut", block);
        el.removeEventListener("drop", block);
      }
    };
    // Re-attach when the columns remount (view-mode switch swaps which refs exist).
  }, [effectiveViewMode]);

  // Attributes that turn a region into a read-only caret host (see the effect
  // above for how edits are blocked). `caret-color` makes the caret visible
  // against the diff background; the outline is suppressed in favour of the
  // subtle focus ring on the surrounding column wrapper.
  // `beforeinput` can't cancel `insertCompositionText`, so an IME attempt on a
  // read-only host could mutate the DOM out from under React. That never makes
  // sense here (the diff isn't typeable), so abort composition the instant it
  // starts by dropping focus — nothing is ever committed.
  const abortComposition = useCallback((e: React.CompositionEvent) => {
    (e.target as HTMLElement).blur();
  }, []);
  const editableHostProps = {
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: false,
    role: "textbox" as const,
    "aria-readonly": true,
    "aria-multiline": true,
    onCompositionStart: abortComposition,
    className: "outline-none [caret-color:var(--text)]",
  };

  /* ── Selection ──────────────────────────────────────────── */

  // Timing (settle multi-clicks, catch releases outside the pane) lives in
  // useCommentSelection; this just maps a settled selection to a diff anchor.
  function resolveSelection(range: Range, sel: Selection, clickCount: number) {
    if (!contentRef.current) return null;
    if (!contentRef.current.contains(range.commonAncestorContainer)) return null;

    let side: "left" | "right" = "right";

    if (effectiveViewMode === "split") {
      const startSide = findSplitSide(range.startContainer);
      const endSide = findSplitSide(range.endContainer);
      // Bail without clearing — clearing mid-gesture is what made cross-line
      // selections feel like they didn't register.
      if (!startSide || !endSide || startSide !== endSide) return null;
      if (startSide === "left") side = "left";
    }

    let start = getAbsoluteOffset(range.startContainer, range.startOffset);
    let end = getAbsoluteOffset(range.endContainer, range.endOffset);
    if (start === -1 || end === -1) return null;
    if (start > end) [start, end] = [end, start];

    let selectedText: string;
    if (clickCount >= 3) {
      // A triple-click is a whole-line gesture, but the table layout makes the
      // browser over-extend it a character into the next row's cell. Don't
      // trust the raw endpoints: snap to the lines the selection fully covers.
      // A following line is included only when the selection spans its entire
      // content, so the stray one-char spill (which never does) is excluded.
      const firstIdx = getDiffLineForOffset(start, dLines);
      let lastIdx = firstIdx;
      while (
        lastIdx + 1 < dLines.length &&
        end >= dLines[lastIdx + 1].flatOffset + dLines[lastIdx + 1].content.length
      ) {
        lastIdx++;
      }
      start = dLines[firstIdx].flatOffset;
      end = dLines[lastIdx].flatOffset + dLines[lastIdx].content.length;
      selectedText = dLines
        .slice(firstIdx, lastIdx + 1)
        .map((l) => l.content)
        .join("\n");
    } else {
      selectedText = sel.toString().trim();
    }
    if (!selectedText) return null;

    // In unified view, determine side from the diff line type
    if (effectiveViewMode === "unified") {
      const lineIdx = getDiffLineForOffset(start, dLines);
      if (dLines[lineIdx]?.type === "remove") side = "left";
    }

    const rect = range.getBoundingClientRect();
    return {
      data: { startOffset: start, endOffset: end, side },
      selectedText,
      position: {
        top: rect.bottom + 8,
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
        ),
      },
    };
  }

  const selection = useCommentSelection<DiffAnchor>({
    enabled: interactive,
    resolve: resolveSelection,
    onCreate: (data, selectedText, comment) =>
      onAddAnnotation?.(
        selectedText,
        data.startOffset,
        data.endOffset,
        comment,
        data.side
      ),
  });
  const pending = selection.pending;

  function submitEdit(comment: string) {
    if (!editing || !onUpdateAnnotation) return;
    onUpdateAnnotation(editing.annotation.id, comment);
    setEditing(null);
  }

  // Stable handlers passed to every memoized LineContent. Kept referentially
  // stable (annotations read through a ref) so a line bails out of re-rendering
  // unless its own content changed — passing fresh closures would defeat the memo.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const handleClickAnn = useCallback((annId: string, rect: DOMRect) => {
    const ann = annotationsRef.current.find((a) => a.id === annId);
    if (!ann) return;
    setEditing({
      annotation: ann,
      pos: {
        top: rect.bottom + 8,
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
        ),
      },
    });
  }, []);
  const handleHoverAnn = useCallback(
    (id: string | null) => setHoveredAnnId(id),
    []
  );

  /* ── Highlights ─────────────────────────────────────────── */

  // `side` is the column being rendered in split view. A context (unchanged)
  // line shares one DiffLine.idx across both columns, so without this filter a
  // highlight anchored to one side bleeds onto the aligned line in the other.
  // Undefined (unified view) means a single column — no filtering needed.
  function hlsForLine(lineIdx: number, side?: "left" | "right"): Hl[] {
    const line = dLines[lineIdx];
    const ls = line.flatOffset;
    const le = ls + line.content.length;
    const out: Hl[] = [];

    for (const a of annotations) {
      if (side && a.side !== side) continue;
      if (a.startOffset < le && a.endOffset > ls) {
        out.push({
          s: Math.max(a.startOffset, ls) - ls,
          e: Math.min(a.endOffset, le) - ls,
          kind: "ann",
          annId: a.id,
        });
      }
    }

    if (
      pending &&
      (!side || pending.data.side === side) &&
      pending.data.startOffset < le &&
      pending.data.endOffset > ls
    ) {
      out.push({
        s: Math.max(pending.data.startOffset, ls) - ls,
        e: Math.min(pending.data.endOffset, le) - ls,
        kind: "pending",
      });
    }

    // Find matches are line-local already and apply to both columns. The active
    // match (find.current) is resolved here so the map can stay stable across
    // next/prev stepping.
    for (const f of findByLine.get(lineIdx) ?? []) {
      out.push({
        s: f.s,
        e: f.e,
        kind: f.i === find.current ? "find-current" : "find",
      });
    }

    // Shared empty constant when there's nothing to paint — keeps the ref stable
    // so undecorated lines bail out of LineContent's memo.
    if (out.length === 0) return EMPTY_HLS;
    return out.sort((a, b) => a.s - b.s);
  }

  /* ── Shared cell styles ─────────────────────────────────── */

  const numCellStyle = (
    type: DiffLine["type"],
    hide?: boolean
  ): React.CSSProperties => ({
    height: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    minWidth: numColW,
    width: numColW,
    color: hide ? "transparent" : "var(--text-tertiary)",
    background: gutterBg(type),
    fontSize: GUTTER_FONT_SIZE,
    padding: "0 8px",
    textAlign: "right",
    verticalAlign: "middle",
    userSelect: "none",
    whiteSpace: "nowrap",
  });

  const contentCellStyle = (type: DiffLine["type"]): React.CSSProperties => ({
    position: "relative", // anchors the fold chevron in the left padding
    minHeight: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    fontSize: settings.fontSize,
    color: "var(--text)",
    background: lineBg(type),
    whiteSpace: settings.lineWrap ? "pre-wrap" : "pre",
    wordBreak: settings.lineWrap ? "break-all" : undefined,
    // Room for the fold chevron (w-5 = 20px) on the left, so it never overlaps
    // the code and there's breathing room between the line numbers and the text.
    paddingLeft: 22,
    paddingRight: 16,
  });

  const barCellStyle = (type: DiffLine["type"]): React.CSSProperties => ({
    width: BAR_WIDTH_PX,
    minWidth: BAR_WIDTH_PX,
    maxWidth: BAR_WIDTH_PX,
    height: LINE_HEIGHT_PX,
    padding: 0,
    background: barColor(type),
  });

  /* ── Fold toggle (lives in the content cell's left padding, never in the
        code text, and only on a region's start line) ───────────── */

  function renderFoldToggle(key: number) {
    const isCollapsed = collapsedFolds.has(key);
    return (
      <button
        contentEditable={false}
        onClick={(e) => {
          e.stopPropagation();
          toggleFold(key);
        }}
        aria-label={isCollapsed ? "Expand region" : "Collapse region"}
        title={isCollapsed ? "Expand" : "Collapse"}
        // Always visible but subtle; brightens on hover.
        className="absolute left-0 top-0 z-10 flex w-5 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] opacity-60 transition-all duration-100 hover:scale-110 hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] hover:opacity-100 active:scale-90"
        style={{ height: LINE_HEIGHT_PX }}
      >
        <FoldChevron collapsed={isCollapsed} />
      </button>
    );
  }

  /** "⋯" affordance appended to a collapsed region's start line. */
  function renderFoldEllipsis(key: number) {
    if (!collapsedFolds.has(key)) return null;
    return (
      <span
        contentEditable={false}
        onClick={(e) => {
          e.stopPropagation();
          toggleFold(key);
        }}
        className="ml-1 cursor-pointer select-none rounded-sm bg-[var(--bg-surface-hover)] px-1 text-[var(--text-tertiary)]"
        title="Expand"
      >
        ⋯
      </span>
    );
  }

  /* ── Inline comment card ─────────────────────────────────── */

  function renderInlineComment(ann: Annotation, index: number) {
    const hovered = hoveredAnnId === ann.id;

    const trunc =
      ann.comment.length > COMMENT_TRUNCATE_LEN
        ? ann.comment.slice(0, COMMENT_TRUNCATE_LEN) + "..."
        : ann.comment;

    return (
      <div
        contentEditable={false}
        className="flex cursor-pointer items-start gap-2 py-1.5 pl-4 pr-3"
        style={{
          background: hovered ? "var(--bg-surface-hover)" : "var(--bg)",
        }}
        onClick={(e) =>
          handleClickAnn(
            ann.id,
            (e.currentTarget as HTMLElement).getBoundingClientRect()
          )
        }
        onMouseEnter={() => setHoveredAnnId(ann.id)}
        onMouseLeave={() => setHoveredAnnId(null)}
      >
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--bg)]">
          {index + 1}
        </span>
        <span className="text-[11px] leading-snug text-[var(--text-secondary)]">
          {trunc}
        </span>
      </div>
    );
  }

  /* ── Settings controls ──────────────────────────────────── */

  // Each control is its own element so the bar (web) and the popover (desktop)
  // can lay out the *same* widgets differently without duplicating their logic.

  function renderViewModeToggle() {
    if (isFirstVersion || !onSettingsChange) return null;
    return (
      <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
        {(["split", "unified"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => onSettingsChange({ viewMode: mode })}
            className={`px-2.5 py-1 transition-colors ${mode === "split" ? "rounded-l-md" : "rounded-r-md border-l border-[var(--border)]"} ${
              settings.viewMode === mode
                ? "bg-[var(--accent)] text-[var(--bg)]"
                : "text-[var(--text-tertiary)]"
            }`}
          >
            {mode === "split" ? "Split" : "Unified"}
          </button>
        ))}
      </div>
    );
  }

  function renderFontSizeSelect() {
    if (!onSettingsChange) return null;
    return (
      <select
        value={settings.fontSize}
        onChange={(e) =>
          onSettingsChange({
            fontSize: Number(e.target.value) as DiffSettings["fontSize"],
          })
        }
        className="cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-transparent px-2 py-1 pr-5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 4px center",
        }}
      >
        {FONT_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
    );
  }

  function renderHideUnchangedToggle() {
    if (!onSettingsChange) return null;
    return (
      <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
        {([true, false] as const).map((hide) => {
          // When the user has manually expanded "N unchanged lines" sections
          // we're in a mixed state — neither toggle reflects reality.
          const isCustomized = expandedSeparators.size > 0;
          const isActive = !isCustomized && settings.hideUnchanged === hide;
          return (
            <button
              key={String(hide)}
              onClick={() => {
                if (hide && settings.hideUnchanged && isCustomized) {
                  // Already in changes-only mode but with expansions —
                  // collapse them back without re-firing hideUnchanged.
                  setExpandedSeparators(new Set());
                  return;
                }
                onSettingsChange({ hideUnchanged: hide });
              }}
              className={`px-2.5 py-1 transition-colors ${hide ? "rounded-l-md" : "rounded-r-md border-l border-[var(--border)]"} ${
                isActive
                  ? "bg-[var(--accent)] text-[var(--bg)]"
                  : "text-[var(--text-tertiary)]"
              }`}
            >
              {hide ? "Changes only" : "All lines"}
            </button>
          );
        })}
      </div>
    );
  }

  function renderLineWrapButton() {
    if (!onSettingsChange) return null;
    return (
      <button
        onClick={() => onSettingsChange({ lineWrap: !settings.lineWrap })}
        className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
          settings.lineWrap
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)]"
        }`}
      >
        Line wrap
      </button>
    );
  }

  function renderIgnoreWhitespaceButton() {
    if (!onSettingsChange) return null;
    return (
      <button
        onClick={() =>
          onSettingsChange({ ignoreWhitespace: !settings.ignoreWhitespace })
        }
        className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
          settings.ignoreWhitespace
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)]"
        }`}
      >
        Ignore whitespace
      </button>
    );
  }

  /** Inline row of controls — the web surface. */
  function renderSettingsBar() {
    if (!onSettingsChange) return null;
    return (
      <div className="mb-2 flex items-center justify-end gap-2">
        {renderViewModeToggle()}
        {renderFontSizeSelect()}
        {renderHideUnchangedToggle()}
        {renderLineWrapButton()}
        {renderIgnoreWhitespaceButton()}
      </div>
    );
  }

  /**
   * Gear button + popover — the desktop surface. Portaled into a header slot
   * (beside "Format") so its logic stays co-located with the diff state it
   * reads, while the trigger lives where the user expects it.
   */
  function renderSettingsPopover() {
    if (!onSettingsChange || !settingsPortalTarget) return null;
    const rows: { label: string; control: ReactNode }[] = [
      { label: "View", control: renderViewModeToggle() },
      { label: "Font size", control: renderFontSizeSelect() },
      { label: "Lines", control: renderHideUnchangedToggle() },
      { label: "Wrap", control: renderLineWrapButton() },
      { label: "Whitespace", control: renderIgnoreWhitespaceButton() },
    ].filter((r) => r.control);

    const menu = (
      <div ref={settingsRef} className="relative">
        <button
          onClick={() => setSettingsOpen((o) => !o)}
          title="Diff settings"
          aria-label="Diff settings"
          aria-expanded={settingsOpen}
          className={`flex h-8 w-8 items-center justify-center rounded-md border text-[15px] transition-colors ${
            settingsOpen
              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
              : "border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          }`}
        >
          ⚙
        </button>
        {settingsOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 flex w-max flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5 shadow-lg">
            {rows.map(({ label, control }) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4"
              >
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {label}
                </span>
                {control}
              </div>
            ))}
          </div>
        )}
      </div>
    );

    return createPortal(menu, settingsPortalTarget);
  }

  /* ── Separator row ─────────────────────────────────────── */

  function renderSeparatorTd(
    colSpan: number,
    hiddenCount: number,
    sepIdx: number
  ) {
    return (
      <td
        colSpan={colSpan}
        contentEditable={false}
        onClick={() => toggleSeparator(sepIdx)}
        className="cursor-pointer select-none border-y border-[var(--border)] bg-[var(--bg)] text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
        style={{ height: SEPARATOR_HEIGHT_PX }}
      >
        <span className="sticky left-0 block w-[100cqi] text-center pointer-events-none">
          ▸ {hiddenCount} unchanged lines
        </span>
      </td>
    );
  }

  /* ── Unified view (table-based) ─────────────────────────── */

  function renderUnified() {
    const sepIndices: number[] = [];
    let si = 0;
    for (const item of expandedFiltered) {
      sepIndices.push(item.type === "separator" ? si++ : -1);
    }

    const colCount = isFirstVersion ? 3 : 4;

    return (
      <div
        ref={unifiedRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-readonly
        aria-multiline
        onCompositionStart={abortComposition}
        className="overflow-x-auto outline-none [caret-color:var(--text)] [container-type:inline-size]"
      >
        <table
          className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]"
        >
          <tbody>
            {expandedFiltered.map((item, i) => {
              if (unifiedFold.hidden.has(i)) return null;
              if (item.type === "separator") {
                return (
                  <tr key={`us${i}`}>
                    {renderSeparatorTd(colCount, item.hiddenCount, sepIndices[i])}
                  </tr>
                );
              }

              const lineAnns = annotationsByEndLine.get(item.idx);
              const vt = visualType(item);
              const fold = unifiedFold.startByRow.get(i);

              return (
                <Fragment key={`u${i}`}>
                  <tr data-dline={item.idx} className="group">
                    <td contentEditable={false} style={barCellStyle(vt)} />
                    {!isFirstVersion && (
                      <td
                        contentEditable={false}
                        className="diff-linenum"
                        data-linenum={item.oldNum ?? ""}
                        style={numCellStyle(vt, item.type === "add")}
                      />
                    )}
                    <td
                      contentEditable={false}
                      className="diff-linenum"
                      data-linenum={item.newNum ?? ""}
                      style={{
                        ...numCellStyle(vt, item.type === "remove"),
                        borderRight: "1px solid var(--border)",
                      }}
                    />
                    <td
                      data-dline={item.idx}
                      style={contentCellStyle(vt)}
                    >
                      {fold && renderFoldToggle(fold.key)}
                      <LineContent
                        text={item.content}
                        lineType={item.type}
                        syntax={tokensForDiffLine(item)}
                        wordSegments={
                          item.wordSegments && !item.whitespaceOnly
                            ? item.wordSegments
                            : null
                        }
                        hls={hlsForLine(item.idx)}
                        hoveredAnnId={hoveredAnnId}
                        onClickAnn={handleClickAnn}
                        onHoverAnn={handleHoverAnn}
                      />
                      {fold && renderFoldEllipsis(fold.key)}
                    </td>
                  </tr>
                  {lineAnns?.map(({ annotation: ann, index }) => (
                    <tr key={`cmt-${ann.id}`}>
                      <td
                        colSpan={colCount}
                        className="border-y border-[var(--border)] p-0"
                      >
                        {renderInlineComment(ann, index)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  /* ── Split view (table-based, column-isolated) ──────────── */

  function renderSplitRow(
    line: DiffLine | undefined,
    side: "left" | "right",
    key: string,
    foldKey: number | null
  ) {
    if (!line) {
      return (
        <tr key={key}>
          <td
            contentEditable={false}
            style={{
              ...numCellStyle("context", true),
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          />
          <td
            contentEditable={false}
            style={{ ...barCellStyle("context"), background: "var(--bg)" }}
          />
          <td
            contentEditable={false}
            className="bg-[var(--bg)]"
            style={{ height: LINE_HEIGHT_PX }}
          />
        </tr>
      );
    }

    const num = side === "left" ? line.oldNum : line.newNum;
    const hideNum =
      (side === "left" && line.type === "add") ||
      (side === "right" && line.type === "remove");
    const vt = visualType(line);

    return (
      <tr key={key} data-dline={line.idx} className="group">
        <td
          contentEditable={false}
          className="diff-linenum"
          data-linenum={hideNum ? "" : (num ?? "")}
          style={{
            ...numCellStyle(vt, hideNum),
            borderRight: "1px solid var(--border)",
          }}
        />
        <td contentEditable={false} style={barCellStyle(vt)} />
        <td
          data-dline={line.idx}
          style={contentCellStyle(vt)}
        >
          {foldKey != null && renderFoldToggle(foldKey)}
          <LineContent
            text={line.content}
            lineType={line.type}
            syntax={tokensForDiffLine(line)}
            wordSegments={
              line.wordSegments && !line.whitespaceOnly ? line.wordSegments : null
            }
            hls={hlsForLine(line.idx, side)}
            hoveredAnnId={hoveredAnnId}
            onClickAnn={handleClickAnn}
            onHoverAnn={handleHoverAnn}
          />
          {foldKey != null && renderFoldEllipsis(foldKey)}
        </td>
      </tr>
    );
  }

  function renderHunkButtons(block: HunkBlock) {
    if (!hunkActions) return null;
    const { range } = block;
    if (hunkActions.isStaged) {
      return (
        <button
          onClick={() => hunkActions.onUnstage(range)}
          title="Unstage this hunk"
          aria-label="Unstage this hunk"
          className="flex h-5 w-5 items-center justify-center rounded text-[13px] leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
        >
          −
        </button>
      );
    }
    return (
      <>
        <button
          onClick={() => hunkActions.onRevert(range)}
          title="Revert this hunk"
          aria-label="Revert this hunk"
          className="flex h-5 w-5 items-center justify-center rounded text-[12px] leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--removed-text)]"
        >
          ↺
        </button>
        <button
          onClick={() => hunkActions.onStage(range)}
          title="Stage this hunk"
          aria-label="Stage this hunk"
          className="flex h-5 w-5 items-center justify-center rounded text-[13px] leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--bg)]"
        >
          ＋
        </button>
      </>
    );
  }

  // The center gutter: a slim, full-height column holding one grey line + one
  // control box per git hunk. Line and box are absolutely positioned children,
  // so they scroll with the content for free; their vertical positions are set
  // imperatively by the measure/place effect above (`opacity-0` until placed).
  function renderGutter() {
    return (
      <div
        ref={gutterRef}
        contentEditable={false}
        className="relative w-8 shrink-0 select-none self-stretch border-r border-[var(--border)] bg-[var(--bg)]"
      >
        {hunkBlocks.map((block) => (
          <Fragment key={block.hunkIdx}>
            <div
              ref={(el) => {
                if (el) hunkLineRefs.current.set(block.hunkIdx, el);
                else hunkLineRefs.current.delete(block.hunkIdx);
              }}
              className="pointer-events-none absolute left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-[var(--text-tertiary)]"
              style={{ top: 0, height: 0 }}
            />
            <div
              ref={(el) => {
                if (el) hunkBoxRefs.current.set(block.hunkIdx, el);
                else hunkBoxRefs.current.delete(block.hunkIdx);
              }}
              data-hunk-control
              onMouseEnter={() => setHoveredHunkIdx(block.hunkIdx)}
              className={`absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] p-0.5 shadow-sm transition-opacity ${
                hoveredHunkIdx === block.hunkIdx
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
              }`}
              style={{ top: 0 }}
            >
              {renderHunkButtons(block)}
            </div>
          </Fragment>
        ))}
      </div>
    );
  }

  function renderSplit() {
    const sepIndices: number[] = [];
    let si = 0;
    for (const row of splitRows) {
      sepIndices.push(row.type === "separator" ? si++ : -1);
    }

    const splitRowComments = splitRows.map((row) => {
      if (row.type === "separator") return [];
      const seen = new Set<string>();
      const result: { annotation: Annotation; index: number }[] = [];
      for (const line of [row.right, row.left]) {
        if (!line) continue;
        const anns = annotationsByEndLine.get(line.idx);
        if (!anns) continue;
        for (const a of anns) {
          if (!seen.has(a.annotation.id)) {
            seen.add(a.annotation.id);
            result.push(a);
          }
        }
      }
      return result;
    });

    function renderColumn(side: "left" | "right") {
      return (
        <div
          data-split-side={side}
          ref={side === "left" ? leftColRef : rightColRef}
          {...editableHostProps}
        >
          <table className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]">
            <tbody>
              {splitRows.map((row, i) => {
                // Hidden by a fold — drop from BOTH columns (same index) so the
                // two panes stay aligned.
                if (splitFold.hidden.has(i)) return null;
                if (row.type === "separator") {
                  return (
                    <tr key={`s${side}${i}`}>
                      {renderSeparatorTd(3, row.hiddenCount, sepIndices[i])}
                    </tr>
                  );
                }

                const line = side === "left" ? row.left : row.right;
                const comments = splitRowComments[i];
                // The chevron shows once per fold-start row, on the column that
                // holds the representative line (right unless it's a remove).
                const fold = splitFold.startByRow.get(i);
                const repSide = row.right ? "right" : "left";
                const foldKey = fold && side === repSide ? fold.key : null;

                return (
                  <Fragment key={`${side}${i}`}>
                    {renderSplitRow(line, side, `r${side}${i}`, foldKey)}
                    {comments.map(({ annotation: ann, index: idx }) => (
                      <tr key={`cmt-${side}-${ann.id}`}>
                        <td
                          colSpan={3}
                          className="border-y border-[var(--border)] p-0"
                        >
                          <div
                            className="overflow-hidden"
                            style={{ height: INLINE_COMMENT_ROW_HEIGHT_PX }}
                          >
                            {side === "right"
                              ? renderInlineComment(ann, idx)
                              : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <div className="flex">
        <div className="min-w-0 flex-1 overflow-x-auto border-r border-[var(--border)] [container-type:inline-size] focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent)]">
          {renderColumn("left")}
        </div>
        {showGutter && renderGutter()}
        <div className="min-w-0 flex-1 overflow-x-auto [container-type:inline-size] focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent)]">
          {renderColumn("right")}
        </div>
      </div>
    );
  }

  /* ── Main render ────────────────────────────────────────── */

  return (
    <div>
      {/* Sticky, zero-height anchor so the find widget stays pinned to the top-
          right of the scroll viewport (works inside the desktop pane and the web
          page alike). FindWidget renders nothing while closed. */}
      {findEnabled && (
        <div className="sticky top-0 z-30 h-0">
          <FindWidget find={find} revealTrigger={findReveal} />
        </div>
      )}
      {settingsVariant === "popover"
        ? renderSettingsPopover()
        : renderSettingsBar()}

      <div
        ref={contentRef}
        onMouseDown={lockSelectionToStartSide}
        onClick={(e) => {
          if (!mergeEnabled) return;
          // Don't trigger on a drag-select.
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
          // Find which line we clicked.
          let el: HTMLElement | null = e.target as HTMLElement | null;
          while (el && !el.hasAttribute("data-dline")) {
            if (el === contentRef.current) return;
            el = el.parentElement;
          }
          if (!el) return;
          const lineIdx = parseInt(el.getAttribute("data-dline")!);
          const changeIdx = lineToChange.get(lineIdx);
          if (changeIdx === undefined) return;
          setActiveChangeIdx(changeIdx);
        }}
        onMouseMove={
          hunkActionsEnabled
            ? (e) => {
                // `undefined` → cursor is on the box itself; keep it revealed
                // (moving onto it must NOT clear the hover, or it would blink).
                if (effectiveViewMode === "split") {
                  const h = hunkHoverFromEvent(e);
                  if (h !== undefined) setHoveredHunkIdx(h);
                  return;
                }
                let el: HTMLElement | null = e.target as HTMLElement | null;
                while (el && !el.hasAttribute("data-dline")) {
                  if (el.hasAttribute("data-hunk-control")) return;
                  if (el === contentRef.current) {
                    setHoverChangeIdx(null);
                    return;
                  }
                  el = el.parentElement;
                }
                if (!el) return;
                const lineIdx = parseInt(el.getAttribute("data-dline")!);
                const changeIdx = lineToChange.get(lineIdx);
                setHoverChangeIdx(changeIdx ?? null);
              }
            : undefined
        }
        onMouseLeave={
          hunkActionsEnabled
            ? () => {
                setHoverChangeIdx(null);
                setHoveredHunkIdx(null);
              }
            : undefined
        }
        // py-7 reserves vertical room at the top & bottom of the diff so the
        // merge overlay's strips have somewhere to live for changes that sit
        // right at the edges. Only allocated when merge is actually enabled.
        className={
          mergeEnabled
            ? "relative select-text overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] py-7 [cursor:text]"
            : "relative select-text overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] [cursor:text]"
        }
      >
        {effectiveViewMode === "unified" ? renderUnified() : renderSplit()}
        {mergeEnabled && activeChangeIdx !== null && overlayPos && (
          <MergeOverlay
            top={overlayPos.top}
            height={overlayPos.height}
            currentIdx={activeChangeIdx}
            totalChanges={changes.length}
            onClose={() => setActiveChangeIdx(null)}
            onPrev={() => goToChange(-1)}
            onNext={() => goToChange(1)}
            onApplyLeftToRight={() => applyMerge("leftToRight")}
            onApplyRightToLeft={() => applyMerge("rightToLeft")}
          />
        )}
        {hunkActionsEnabled &&
          hunkActions &&
          effectiveViewMode !== "split" &&
          hoverChangeIdx !== null &&
          hunkCtrlTop !== null &&
          changes[hoverChangeIdx] && (
            <div
              data-hunk-control
              contentEditable={false}
              className="absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 select-none items-center gap-1"
              style={{ top: Math.max(10, hunkCtrlTop) }}
            >
              {hunkActions.isStaged ? (
                <button
                  onClick={() =>
                    hunkActions.onUnstage(changeRange(changes[hoverChangeIdx]))
                  }
                  title="Unstage this hunk"
                  className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--bg-surface-hover)]"
                >
                  − Unstage hunk
                </button>
              ) : (
                <>
                  <button
                    onClick={() =>
                      hunkActions.onRevert(changeRange(changes[hoverChangeIdx]))
                    }
                    title="Revert this hunk"
                    className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--removed-text)]"
                  >
                    ↺ Revert
                  </button>
                  <button
                    onClick={() =>
                      hunkActions.onStage(changeRange(changes[hoverChangeIdx]))
                    }
                    title="Stage this hunk"
                    className="rounded bg-[var(--accent)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--bg)] shadow-sm transition-opacity hover:opacity-90"
                  >
                    + Stage hunk
                  </button>
                </>
              )}
            </div>
          )}
      </div>

      {pending && (
        <CommentPopover
          position={pending.position}
          selectedText={pending.selectedText}
          onSubmit={selection.submit}
          onClose={selection.cancel}
        />
      )}
      {editing && (
        <CommentPopover
          position={editing.pos}
          selectedText={editing.annotation.selectedText}
          initialComment={editing.annotation.comment}
          submitLabel="Save"
          onSubmit={submitEdit}
          onClose={() => setEditing(null)}
          onDelete={() => {
            onRemoveAnnotation?.(editing.annotation.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
