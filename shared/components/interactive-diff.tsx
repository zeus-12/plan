"use client";

import {
  useRef,
  useState,
  useMemo,
  useCallback,
  useEffect,
  Fragment,
  type ReactNode,
} from "react";
import type { Annotation } from "../lib/store";
import { type DiffSettings, FONT_SIZE_OPTIONS } from "../lib/settings";
import {
  type DiffLine,
  type FilteredItem,
  type SplitRow,
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
import { highlightPerLine, type SyntaxToken } from "../lib/highlight";
import { useShikiReady } from "../lib/shiki";
import { useCommentSelection } from "../lib/use-comment-selection";
import { CommentPopover } from "./comment-popover";

/* ── Constants ────────────────────────────────────────────── */

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
    onStage: (range: HunkRange) => void;
    onRevert: (range: HunkRange) => void;
    onUnstage: (range: HunkRange) => void;
  };
}

export interface HunkRange {
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

/* ── Style helpers ────────────────────────────────────────── */

function visualType(line: DiffLine): DiffLine["type"] {
  return line.whitespaceOnly ? "context" : line.type;
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
}: Props) {
  const mergeEnabled = !!onMergeChange;
  const hunkActionsEnabled = !!hunkActions;
  const contentRef = useRef<HTMLDivElement>(null);
  // Split-view column wrappers — used to lock a text selection to the side it
  // started in (the two versions are separate tables, so a native drag-select
  // would otherwise bleed into the other version's aligned lines).
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  const [hoveredAnnId, setHoveredAnnId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingAnn | null>(null);
  const [expandedSeparators, setExpandedSeparators] = useState<Set<number>>(
    new Set()
  );

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

  /* ── Syntax highlighting (per source line) ─────────────────── */

  // Triggers re-render once shiki finishes loading so first-paint tokens
  // (which were empty) get replaced with colored ones.
  const shikiReady = useShikiReady();
  const oldLineTokens = useMemo(
    () => highlightPerLine(oldText, language),
    // shikiReady is part of the deps so memo invalidates when the highlighter
    // becomes ready.
    [oldText, language, shikiReady]
  );
  const newLineTokens = useMemo(
    () => highlightPerLine(newText, language),
    [newText, language, shikiReady]
  );

  function tokensForDiffLine(line: DiffLine): SyntaxToken[] {
    if (line.type === "remove") {
      return oldLineTokens[(line.oldNum ?? 0) - 1] ?? [];
    }
    return newLineTokens[(line.newNum ?? 0) - 1] ?? [];
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

  useEffect(() => {
    setHoverChangeIdx(null);
  }, [oldText, newText]);

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

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let within = 0;
    let cur: Node | null = walker.nextNode();
    while (cur) {
      if (cur === node) {
        within += nodeOff;
        break;
      }
      within += cur.textContent?.length ?? 0;
      cur = walker.nextNode();
    }
    return line.flatOffset + within;
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

  /* ── Selection ──────────────────────────────────────────── */

  // Timing (settle multi-clicks, catch releases outside the pane) lives in
  // useCommentSelection; this just maps a settled selection to a diff anchor.
  function resolveSelection(range: Range, sel: Selection) {
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

    const text = sel.toString();
    if (!text.trim()) return null;

    const start = getAbsoluteOffset(range.startContainer, range.startOffset);
    const end = getAbsoluteOffset(range.endContainer, range.endOffset);
    if (start === -1 || end === -1) return null;

    // In unified view, determine side from the diff line type
    if (effectiveViewMode === "unified") {
      const lineIdx = getDiffLineForOffset(start, dLines);
      if (dLines[lineIdx]?.type === "remove") side = "left";
    }

    const rect = range.getBoundingClientRect();
    return {
      data: { startOffset: start, endOffset: end, side },
      selectedText: text.trim(),
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

  function openEdit(ann: Annotation, rect: DOMRect) {
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
  }

  /* ── Highlights ─────────────────────────────────────────── */

  type Hl = { s: number; e: number; kind: "ann" | "pending"; annId?: string };

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

    return out.sort((a, b) => a.s - b.s);
  }

  function renderContent(lineIdx: number, side?: "left" | "right"): ReactNode {
    const line = dLines[lineIdx];
    const txt = line.content;
    if (!txt) return "\u00A0";

    const hls = hlsForLine(lineIdx, side);
    const syntax = tokensForDiffLine(line);
    const wordSegments =
      line.wordSegments && !line.whitespaceOnly ? line.wordSegments : null;
    const wordBgVar =
      line.type === "add"
        ? "var(--diff-add-word)"
        : line.type === "remove"
          ? "var(--diff-remove-word)"
          : null;

    if (hls.length === 0 && syntax.length === 0 && !wordSegments) {
      return txt;
    }

    // Build flat list of breakpoints (every range start/end), then walk segments
    const bounds = new Set<number>([0, txt.length]);
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
      .filter((b) => b >= 0 && b <= txt.length)
      .sort((a, b) => a - b);

    // Pre-index word-segment offsets so we can look up per char
    let wordOffsets: { start: number; end: number; changed: boolean }[] = [];
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
      const slice = txt.slice(s, e);

      const synTok = findSyntax(s);
      const annHl = findAnn(s);
      const wordSeg = findWord(s);

      const isAnn = annHl?.kind === "ann";
      const isPending = annHl?.kind === "pending";
      const hovered = isAnn && hoveredAnnId === annHl?.annId;

      const wantsBg = isAnn || isPending || (wordSeg && wordSeg.changed);
      const background =
        hovered
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
      if (synTok?.lightColor || synTok?.darkColor) classNames.push("shiki-tok");
      if (wantsBg) classNames.push("rounded-sm");
      if (isAnn) classNames.push("cursor-pointer", "border-b-[1.5px]", "border-[var(--text-tertiary)]");

      const style: React.CSSProperties & Record<string, string | undefined> = {};
      if (background) style.background = background;
      if (synTok?.lightColor) style["--shiki-light"] = synTok.lightColor;
      if (synTok?.darkColor) style["--shiki-dark"] = synTok.darkColor;
      if (synTok?.italic) style.fontStyle = "italic";
      if (synTok?.bold) style.fontWeight = "600";

      const annId = isAnn ? annHl?.annId : undefined;

      parts.push(
        <span
          key={`p${s}`}
          className={classNames.join(" ") || undefined}
          style={Object.keys(style).length > 0 ? style : undefined}
          onClick={
            isAnn
              ? (event) => {
                  event.stopPropagation();
                  const ann = annotations.find((a) => a.id === annId);
                  if (ann)
                    openEdit(
                      ann,
                      (event.currentTarget as HTMLElement).getBoundingClientRect()
                    );
                }
              : undefined
          }
          onMouseEnter={isAnn && annId ? () => setHoveredAnnId(annId) : undefined}
          onMouseLeave={isAnn ? () => setHoveredAnnId(null) : undefined}
        >
          {slice}
        </span>
      );
    }
    return <>{parts}</>;
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
    minHeight: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    fontSize: settings.fontSize,
    color: "var(--text)",
    background: lineBg(type),
    whiteSpace: settings.lineWrap ? "pre-wrap" : "pre",
    wordBreak: settings.lineWrap ? "break-all" : undefined,
    paddingLeft: 12,
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

  /* ── Inline comment card ─────────────────────────────────── */

  function renderInlineComment(ann: Annotation, index: number) {
    const hovered = hoveredAnnId === ann.id;

    const trunc =
      ann.comment.length > COMMENT_TRUNCATE_LEN
        ? ann.comment.slice(0, COMMENT_TRUNCATE_LEN) + "..."
        : ann.comment;

    return (
      <div
        className="flex cursor-pointer items-start gap-2 py-1.5 pl-4 pr-3"
        style={{
          background: hovered ? "var(--bg-surface-hover)" : "var(--bg)",
        }}
        onClick={(e) =>
          openEdit(
            ann,
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

  /* ── Settings bar ───────────────────────────────────────── */

  function renderSettingsBar() {
    if (!onSettingsChange) return null;
    return (
      <div className="mb-2 flex items-center justify-end gap-2">
        {!isFirstVersion && (
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
        )}
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
        <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
          {([true, false] as const).map((hide) => {
            // When the user has manually expanded "N unchanged lines" sections
            // we're in a mixed state — neither toggle reflects reality.
            const isCustomized = expandedSeparators.size > 0;
            const isActive =
              !isCustomized && settings.hideUnchanged === hide;
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
        <button
          onClick={() =>
            onSettingsChange({ lineWrap: !settings.lineWrap })
          }
          className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
            settings.lineWrap
              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
              : "border-[var(--border)] text-[var(--text-tertiary)]"
          }`}
        >
          Line wrap
        </button>
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
      </div>
    );
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
      <div className="overflow-x-auto [container-type:inline-size]">
        <table
          className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]"
        >
          <tbody>
            {expandedFiltered.map((item, i) => {
              if (item.type === "separator") {
                return (
                  <tr key={`us${i}`}>
                    {renderSeparatorTd(colCount, item.hiddenCount, sepIndices[i])}
                  </tr>
                );
              }

              const lineAnns = annotationsByEndLine.get(item.idx);
              const vt = visualType(item);

              return (
                <Fragment key={`u${i}`}>
                  <tr data-dline={item.idx}>
                    <td style={barCellStyle(vt)} />
                    {!isFirstVersion && (
                      <td style={numCellStyle(vt, item.type === "add")}>
                        {item.oldNum ?? ""}
                      </td>
                    )}
                    <td
                      style={{
                        ...numCellStyle(vt, item.type === "remove"),
                        borderRight: "1px solid var(--border)",
                      }}
                    >
                      {item.newNum ?? ""}
                    </td>
                    <td
                      data-dline={item.idx}
                      style={contentCellStyle(vt)}
                    >
                      {renderContent(item.idx)}
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
    key: string
  ) {
    if (!line) {
      return (
        <tr key={key}>
          <td
            style={{
              ...numCellStyle("context", true),
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          />
          <td
            style={{ ...barCellStyle("context"), background: "var(--bg)" }}
          />
          <td
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
      <tr key={key} data-dline={line.idx}>
        <td
          style={{
            ...numCellStyle(vt, hideNum),
            borderRight: "1px solid var(--border)",
          }}
        >
          {hideNum ? "" : (num ?? "")}
        </td>
        <td style={barCellStyle(vt)} />
        <td
          data-dline={line.idx}
          style={contentCellStyle(vt)}
        >
          {renderContent(line.idx, side)}
        </td>
      </tr>
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
        >
          <table className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]">
            <tbody>
              {splitRows.map((row, i) => {
                if (row.type === "separator") {
                  return (
                    <tr key={`s${side}${i}`}>
                      {renderSeparatorTd(3, row.hiddenCount, sepIndices[i])}
                    </tr>
                  );
                }

                const line = side === "left" ? row.left : row.right;
                const comments = splitRowComments[i];

                return (
                  <Fragment key={`${side}${i}`}>
                    {renderSplitRow(line, side, `r${side}${i}`)}
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
        <div className="shrink-0 basis-1/2 overflow-x-auto border-r border-[var(--border)] [container-type:inline-size]">
          {renderColumn("left")}
        </div>
        <div className="shrink-0 basis-1/2 overflow-x-auto [container-type:inline-size]">
          {renderColumn("right")}
        </div>
      </div>
    );
  }

  /* ── Main render ────────────────────────────────────────── */

  return (
    <div>
      {renderSettingsBar()}

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
                let el: HTMLElement | null = e.target as HTMLElement | null;
                while (el && !el.hasAttribute("data-dline")) {
                  // Moving onto the floating control itself must NOT clear the
                  // hover — otherwise the control unmounts the instant the
                  // cursor reaches it, and re-mounts when it falls back onto the
                  // line underneath, producing a blink loop.
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
          hunkActionsEnabled ? () => setHoverChangeIdx(null) : undefined
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
          hoverChangeIdx !== null &&
          hunkCtrlTop !== null &&
          changes[hoverChangeIdx] && (
            <div
              data-hunk-control
              className="absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
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
