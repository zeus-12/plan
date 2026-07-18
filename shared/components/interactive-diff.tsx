"use client";

import {
  useRef,
  useState,
  useMemo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  Fragment,
} from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "../lib/store";
import type { DiffSettings } from "../lib/settings";
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
import type { GitHunk, HunkRange } from "../lib/git-hunks";
import { highlightPerLine, type SyntaxToken } from "../lib/highlight";
import {
  SYNC_HIGHLIGHT_MAX_CHARS,
  useActiveShikiTheme,
  useShikiReady,
} from "../lib/shiki";
import { computeFoldRanges } from "../lib/folding";
import { textBoundaryAt } from "../lib/dom-text";
import { cn, toggleInSet } from "../lib/utils";
import { useCommentSelection } from "../lib/use-comment-selection";
import { useTextFind } from "../lib/use-text-find";
import { CommentPopover } from "./comment-popover";
import { FindWidget } from "./find-widget";
import {
  LineContent,
  EMPTY_TOKENS,
  EMPTY_HLS,
  type Hl,
} from "./diff/line-content";
import { MergeOverlay } from "./diff/merge-overlay";
import { DiffSettingsControls } from "./diff/settings-controls";
import { useReadonlyCaretHost } from "./diff/use-readonly-caret-host";

/** Re-exported: HunkRange is part of the hunkActions contract below. */
export type { HunkRange } from "../lib/git-hunks";

/* ── Constants ────────────────────────────────────────────── */

// Stable empty per-line token array used while highlighting is deferred.
const EMPTY_LINE_TOKENS: SyntaxToken[][] = [];
// Stable default for the annotations prop — a `= []` default would mint a new
// identity every render and invalidate the memoized row trees for nothing.
const EMPTY_ANNOTATIONS: Annotation[] = [];
// The pending-comment highlight (the selection kept visible while the comment
// popover is open, after the popover's focus clears the native selection)
// paints through the CSS Highlight API: a Range in this registry entry, styled
// by ::highlight(pending-comment) in each app's global CSS. Painting it as
// per-line span decorations instead would make `pending` an input of the
// memoized row trees — rebuilding every row on each selection commit, the last
// per-gesture full rebuild. Guarded for SSR/engines without the API; when
// unsupported, hlsForLine falls back to span painting.
// The ::highlight() rule is injected at runtime (not static CSS) because this
// component is shared and Turbopack's CSS parser (web build) rejects the
// ::highlight() syntax — same approach as the chat surface's highlights.
const pendingHl =
  typeof Highlight !== "undefined" &&
  typeof CSS !== "undefined" &&
  "highlights" in CSS
    ? new Highlight()
    : null;
if (pendingHl) {
  CSS.highlights.set("pending-comment", pendingHl);
  const STYLE_ID = "diff-pending-comment-highlight";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
::highlight(pending-comment) {
  background-color: var(--selection-bg);
}
`;
    document.head.appendChild(style);
  }
}
// Stable empty list for the searchable visible-line set while find is closed.
const EMPTY_VISIBLE_LINES: DiffLine[] = [];
const LINE_HEIGHT_PX = 22;
const SEPARATOR_HEIGHT_PX = 32;
const COMMENT_TRUNCATE_LEN = 55;
const INLINE_COMMENT_ROW_HEIGHT_PX = 32;
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
    side: "left" | "right",
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
  /**
   * Opt-in inline git blame. Clicking a row shows a muted trailing annotation
   * (`labelFor`'s text) after that row's code; hovering/clicking the
   * annotation reports back so the caller can raise a commit-details card.
   * Line numbers are 1-based within the given side's source text. The label
   * text is rendered via a CSS pseudo-element, so selecting/copying diff text
   * never captures it.
   */
  blame?: DiffBlame;
}

export interface DiffBlame {
  labelFor: (side: "left" | "right", lineNum: number) => string | null;
  onChipEnter: (side: "left" | "right", lineNum: number, rect: DOMRect) => void;
  onChipLeave: () => void;
  onChipClick: (side: "left" | "right", lineNum: number, rect: DOMRect) => void;
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
  collapsed: Set<number>,
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

/* ── Component ────────────────────────────────────────────── */

export function InteractiveDiff({
  oldText,
  newText,
  settings,
  onSettingsChange,
  isFirstVersion = false,
  language = "plaintext",
  annotations = EMPTY_ANNOTATIONS,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onMergeChange,
  hunkActions,
  findEnabled = true,
  settingsVariant = "bar",
  settingsPortalTarget,
  blame,
}: Props) {
  const mergeEnabled = !!onMergeChange;
  const hunkActionsEnabled = !!hunkActions;
  // Presence-only flag used inside the memoized row trees (the blame object's
  // identity changes every parent render; the rows only care that it exists).
  const blameEnabled = !!blame;
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
    new Set(),
  );
  // Start lines (DiffLine.idx) of the regions the user has collapsed.
  const [collapsedFolds, setCollapsedFolds] = useState<Set<number>>(new Set());

  const interactive = !!onAddAnnotation;
  const effectiveViewMode = isFirstVersion ? "unified" : settings.viewMode;

  useEffect(() => {
    setExpandedSeparators(new Set());
  }, [oldText, newText, settings.hideUnchanged]);

  // The row whose inline blame annotation is showing (set by clicking a row).
  // Keyed by DiffLine.idx + side; cleared whenever the underlying text changes
  // so a stale annotation can never describe new content.
  const [blameSel, setBlameSel] = useState<{
    side: "left" | "right";
    idx: number;
  } | null>(null);
  useEffect(() => {
    setBlameSel(null);
  }, [oldText, newText]);

  // Row click → blame selection. A click that ends a text-selection gesture
  // (double-click word select, drag release over the same cell) is not a blame
  // request — and acting on it would rebuild the row trees mid-gesture, which
  // is exactly the jank this guards against. Re-clicking the selected row
  // returns the same state so React bails out of the render entirely.
  const blameRowClick = useCallback((side: "left" | "right", idx: number) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    setBlameSel((prev) =>
      prev && prev.side === side && prev.idx === idx ? prev : { side, idx },
    );
  }, []);

  /** The selected row's trailing blame annotation, or null. Rendered through a
   *  portal into that row's content cell (see blameChipHost below) so toggling
   *  it re-renders one chip, never the memoized row trees. */
  function renderBlameChipContent() {
    if (!blame || !blameSel) return null;
    const line = dLines[blameSel.idx];
    if (!line) return null;
    const side = blameSel.side;
    const num = side === "left" ? line.oldNum : line.newNum;
    if (num == null) return null;
    const label = blame.labelFor(side, num);
    if (!label) return null;
    return (
      <span
        contentEditable={false}
        data-blame-label={label}
        className="blame-chip"
        onMouseEnter={(e) =>
          blame.onChipEnter(side, num, e.currentTarget.getBoundingClientRect())
        }
        onMouseLeave={() => blame.onChipLeave()}
        onClick={(e) => {
          e.stopPropagation();
          blame.onChipClick(side, num, e.currentTarget.getBoundingClientRect());
        }}
      />
    );
  }

  /* ── Diff computation ───────────────────────────────────── */

  const dLines = useMemo(
    () => buildDiffLines(oldText, newText, settings.ignoreWhitespace),
    [oldText, newText, settings.ignoreWhitespace],
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
    setCollapsedFolds((prev) => toggleInSet(prev, key));
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
    [expandedFiltered],
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
            : { content: it.content, key: it.idx },
        ),
        collapsedFolds,
      ),
    [expandedFiltered, collapsedFolds],
  );
  const splitFold = useMemo(
    () =>
      computeRowFolds(
        splitRows.map((row) => {
          if (row.type === "separator") return { content: "", key: -1 };
          const rep = row.right ?? row.left;
          return { content: rep?.content ?? "", key: rep?.idx ?? -1 };
        }),
        collapsedFolds,
      ),
    [splitRows, collapsedFolds],
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
            (it): it is DiffLine => it.type !== "separator",
          )
        : EMPTY_VISIBLE_LINES,
    [find.open, expandedFiltered],
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
    [findLineStarts],
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
        find.show(
          sel && sel.length <= 200 && !sel.includes("\n") ? sel : undefined,
        );
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
    () =>
      tokensStale ? EMPTY_LINE_TOKENS : highlightPerLine(oldText, language),
    // shikiReady / shikiTheme are deps so the memo invalidates when the
    // highlighter becomes ready and re-tokenizes when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oldText, tokensStale, language, shikiReady, shikiTheme],
  );
  const newLineTokens = useMemo(
    () =>
      tokensStale ? EMPTY_LINE_TOKENS : highlightPerLine(newText, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newText, tokensStale, language, shikiReady, shikiTheme],
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
    [dLines, blocksEnabled],
  );
  const lineToChange = useMemo(
    () =>
      blocksEnabled ? buildLineToChangeMap(changes) : new Map<number, number>(),
    [changes, blocksEnabled],
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
      n: number,
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
    hunkActionsEnabled &&
    effectiveViewMode === "split" &&
    hunkBlocks.length > 0;

  const gutterRef = useRef<HTMLDivElement>(null);
  const hunkBoxRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const hunkLineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Cached pixel extent (top/bottom in gutter-local coords) of each hunk.
  // Measured only on layout changes; the scroll handler reads these, never the
  // DOM — which is why the box can't jitter or drift the way earlier tries did.
  const hunkExtents = useRef<Map<number, { top: number; bottom: number }>>(
    new Map(),
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
          max < min
            ? (ext.top + ext.bottom) / 2
            : Math.min(Math.max(center, min), max)
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
  const [overlayPos, setOverlayPos] = useState<{
    top: number;
    height: number;
  } | null>(null);

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
      `[data-dline="${change.startLineIdx}"]`,
    );
    const endEl = root.querySelector<HTMLElement>(
      `[data-dline="${change.endLineIdx}"]`,
    );
    if (!startEl || !endEl) return;
    const rootRect = root.getBoundingClientRect();
    const startRect = startEl.getBoundingClientRect();
    const endRect = endEl.getBoundingClientRect();
    setOverlayPos({
      top: startRect.top - rootRect.top,
      height: endRect.bottom - startRect.top,
    });
  }, [
    activeChangeIdx,
    changes,
    settings.viewMode,
    settings.hideUnchanged,
    expandedSeparators,
  ]);

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
          ? {
              left: applyChangeRightToLeft(oldText, change, dLines),
              right: newText,
            }
          : {
              left: oldText,
              right: applyChangeLeftToRight(newText, change, dLines),
            };
      onMergeChange(next);
      setActiveChangeIdx(null);
    },
    [activeChangeIdx, changes, dLines, oldText, newText, onMergeChange],
  );

  const goToChange = useCallback(
    (delta: number) => {
      if (changes.length === 0) return;
      const cur = activeChangeIdx ?? -1;
      const next = (cur + delta + changes.length) % changes.length;
      setActiveChangeIdx(next);
    },
    [changes.length, activeChangeIdx],
  );

  /* ── Inline hunk-staging affordance ─────────────────────── */

  // Hover reveal is IMPERATIVE (refs + direct style writes), not React state.
  // It rides mousemove, and a state flip here re-rendered the entire
  // (unvirtualized) diff on every hunk crossing — the main source of pointer
  // lag on large files. The boxes/control are always mounted; only their
  // visibility and position are touched, so no render work happens on hover.

  // Split-view: which hunk's gutter box is currently revealed. Only one box is
  // ever shown, so oversized boxes on small hunks can't collide.
  const hunkHoverRef = useRef<number | null>(null);
  const applyHunkHover = useCallback((idx: number | null) => {
    if (hunkHoverRef.current === idx) return;
    const prev =
      hunkHoverRef.current == null
        ? null
        : hunkBoxRefs.current.get(hunkHoverRef.current);
    hunkHoverRef.current = idx;
    if (prev) {
      prev.style.opacity = "0";
      prev.style.pointerEvents = "none";
    }
    const next = idx == null ? null : hunkBoxRefs.current.get(idx);
    if (next) {
      next.style.opacity = "1";
      next.style.pointerEvents = "auto";
    }
  }, []);

  // Unified-view: the floating stage/revert control. Same imperative pattern —
  // the mousemove handler positions/reveals it directly; the buttons read the
  // hovered change back through hoverChangeRef at click time.
  const hoverChangeRef = useRef<number | null>(null);
  const unifiedCtrlRef = useRef<HTMLDivElement>(null);
  const changesRef = useRef<Change[]>([]);
  changesRef.current = changes;
  const applyChangeHover = useCallback((idx: number | null) => {
    if (hoverChangeRef.current === idx) return;
    hoverChangeRef.current = idx;
    const ctrl = unifiedCtrlRef.current;
    if (!ctrl) return;
    const root = contentRef.current;
    const change = idx == null ? undefined : changesRef.current[idx];
    if (!change || !root) {
      ctrl.style.display = "none";
      return;
    }
    const startEl = root.querySelector<HTMLElement>(
      `[data-dline="${change.startLineIdx}"]`,
    );
    if (!startEl) {
      ctrl.style.display = "none";
      return;
    }
    const endEl =
      root.querySelector<HTMLElement>(`[data-dline="${change.endLineIdx}"]`) ??
      startEl;
    const rootRect = root.getBoundingClientRect();
    // Center the control vertically on the hunk (VS Code-style).
    const top =
      (startEl.getBoundingClientRect().top +
        endEl.getBoundingClientRect().bottom) /
        2 -
      rootRect.top;
    ctrl.style.top = `${Math.max(10, top)}px`;
    ctrl.style.display = "flex";
  }, []);

  // Clear both hovers when the texts change (indices no longer valid) or the
  // view mode swaps (the elements remount hidden; the refs must match).
  useEffect(() => {
    applyHunkHover(null);
    applyChangeHover(null);
  }, [oldText, newText, effectiveViewMode, applyHunkHover, applyChangeHover]);

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

  const changeRange = useCallback((change: Change): HunkRange => {
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
  }, []);

  /* ── Inline comment positions (by end line) ─────────────── */

  const annotationsByEndLine = useMemo(() => {
    const map = new Map<number, { annotation: Annotation; index: number }[]>();
    annotations.forEach((a, i) => {
      const lineIdx = getDiffLineForOffset(
        Math.max(0, a.endOffset - 1),
        dLines,
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
    0,
  );
  const numDigits = Math.max(String(maxLineNum).length, 1);
  const numColW = numDigits * NUM_DIGIT_WIDTH + NUM_COL_PAD;

  /* ── Separator toggle ───────────────────────────────────── */

  const toggleSeparator = useCallback((idx: number) => {
    setExpandedSeparators((prev) => toggleInSet(prev, idx));
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

  // Read-only caret hosts: each side is a contentEditable region (real caret,
  // native caret navigation, browser-scoped ⌘A) with every mutation blocked at
  // the source — see useReadonlyCaretHost. Re-attaches when a view-mode switch
  // swaps which refs exist.
  const editableHostProps = useReadonlyCaretHost(
    [leftColRef, rightColRef, unifiedRef],
    effectiveViewMode,
  );
  // Wrap mode promises "no horizontal scrolling", but the out-of-flow blame
  // annotation still counts toward scrollable overflow — so the host must
  // CLIP x-overflow instead of scrolling it (a too-long annotation is cut at
  // the pane edge, like VS Code; the full text lives in the hover card).
  // Non-wrap keeps the scroller: long lines, and the annotation past them,
  // stay reachable by scrolling.
  const hostClassName = cn(
    editableHostProps.className,
    settings.lineWrap && "overflow-x-clip",
  );

  /* ── Selection ──────────────────────────────────────────── */

  // Timing (settle multi-clicks, catch releases outside the pane) lives in
  // useCommentSelection; this just maps a settled selection to a diff anchor.
  function resolveSelection(range: Range, sel: Selection, clickCount: number) {
    if (!contentRef.current) return null;
    if (!contentRef.current.contains(range.commonAncestorContainer))
      return null;

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
        end >=
          dLines[lastIdx + 1].flatOffset + dLines[lastIdx + 1].content.length
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

    // CommentPopover clamps itself into the viewport.
    const rect = range.getBoundingClientRect();
    return {
      data: { startOffset: start, endOffset: end, side },
      selectedText,
      position: { top: rect.bottom + 8, left: rect.left },
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
        data.side,
      ),
  });
  const pending = selection.pending;
  // Span-painting fallback for engines without the Highlight API. Null on
  // modern engines, so the row-tree memo deps stay inert across selection
  // commits and the pending paint goes through pendingHl instead.
  const pendingFallback = pendingHl ? null : pending;

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
      pos: { top: rect.bottom + 8, left: rect.left },
    });
  }, []);
  const handleHoverAnn = useCallback(
    (id: string | null) => setHoveredAnnId(id),
    [],
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
      pendingFallback &&
      (!side || pendingFallback.data.side === side) &&
      pendingFallback.data.startOffset < le &&
      pendingFallback.data.endOffset > ls
    ) {
      out.push({
        s: Math.max(pendingFallback.data.startOffset, ls) - ls,
        e: Math.min(pendingFallback.data.endOffset, le) - ls,
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
    hide?: boolean,
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
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
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

  /* ── Separator row ─────────────────────────────────────── */

  function renderSeparatorTd(
    colSpan: number,
    hiddenCount: number,
    sepIdx: number,
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
      <div ref={unifiedRef} {...editableHostProps} className={hostClassName}>
        <table className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]">
          <tbody>
            {expandedFiltered.map((item, i) => {
              if (unifiedFold.hidden.has(i)) return null;
              if (item.type === "separator") {
                return (
                  <tr key={`us${i}`}>
                    {renderSeparatorTd(
                      colCount,
                      item.hiddenCount,
                      sepIndices[i],
                    )}
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
                      // Unified rows: removed lines only exist in the old
                      // text, everything else is annotated via the new text.
                      onClick={
                        blameEnabled
                          ? () =>
                              blameRowClick(
                                item.type === "remove" ? "left" : "right",
                                item.idx,
                              )
                          : undefined
                      }
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
    foldKey: number | null,
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
          onClick={
            blameEnabled ? () => blameRowClick(side, line.idx) : undefined
          }
        >
          {foldKey != null && renderFoldToggle(foldKey)}
          <LineContent
            text={line.content}
            lineType={line.type}
            syntax={tokensForDiffLine(line)}
            wordSegments={
              line.wordSegments && !line.whitespaceOnly
                ? line.wordSegments
                : null
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

  // The center gutter: a narrow full-height column holding one grey line + one
  // control box per git hunk. Line and box are absolutely positioned children,
  // so they scroll with the content for free; their vertical positions are set
  // imperatively by the measure/place effect above (`opacity-0` until placed).
  //
  // Sized to hold the stage/revert control box (~26px: 20px buttons + padding +
  // border) without it overhanging the code, while still trimming the divider
  // from the old w-8 (32px). w-7 (28px) is the tightest that fits the box.
  function renderGutter() {
    return (
      <div
        ref={gutterRef}
        contentEditable={false}
        className="relative w-7 shrink-0 select-none self-stretch border-r border-[var(--border)] bg-[var(--bg)]"
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
              onMouseEnter={() => applyHunkHover(block.hunkIdx)}
              // Hidden by default; applyHunkHover reveals it with direct style
              // writes (opacity/pointerEvents) so hover never re-renders.
              className="absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] p-0.5 shadow-sm transition-opacity"
              style={{ top: 0, opacity: 0, pointerEvents: "none" }}
            >
              {renderHunkButtons(block)}
            </div>
          </Fragment>
        ))}
      </div>
    );
  }

  const splitSepIndices = useMemo(() => {
    const arr: number[] = [];
    let si = 0;
    for (const row of splitRows) {
      arr.push(row.type === "separator" ? si++ : -1);
    }
    return arr;
  }, [splitRows]);

  const splitRowComments = useMemo(
    () =>
      splitRows.map((row) => {
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
      }),
    [splitRows, annotationsByEndLine],
  );

  function renderColumn(side: "left" | "right") {
    return (
      <div
        data-split-side={side}
        ref={side === "left" ? leftColRef : rightColRef}
        {...editableHostProps}
        className={hostClassName}
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
                    {renderSeparatorTd(3, row.hiddenCount, splitSepIndices[i])}
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

  /* ── Memoized row trees ─────────────────────────────────── */
  //
  // The row trees are the expensive part of a render: thousands of cells on a
  // large file, of which only the LineContent leaves are memoized. Freezing
  // the rendered trees behind useMemo means interaction state that lives
  // OUTSIDE them — the imperative hover reveals, the blame chip (portaled),
  // popovers, the merge overlay, the find widget — re-renders this component
  // without rebuilding a single row. Everything the rows read is a dependency;
  // stable callbacks (blameRowClick, toggle*, handle*Ann, LineContent
  // handlers) and editableHostProps (constant contents, fresh identity each
  // render) are deliberately not.
  /* eslint-disable react-hooks/exhaustive-deps */
  const unifiedBody = useMemo(
    () => (effectiveViewMode === "unified" ? renderUnified() : null),
    [
      effectiveViewMode,
      expandedFiltered,
      unifiedFold,
      isFirstVersion,
      annotationsByEndLine,
      collapsedFolds,
      oldLineTokens,
      newLineTokens,
      annotations,
      pendingFallback,
      findByLine,
      find.current,
      hoveredAnnId,
      settings.fontSize,
      settings.lineWrap,
      numColW,
      hostClassName,
      blameEnabled,
      dLines,
    ],
  );
  const leftColumn = useMemo(
    () => (effectiveViewMode === "split" ? renderColumn("left") : null),
    [
      effectiveViewMode,
      splitRows,
      splitFold,
      splitSepIndices,
      splitRowComments,
      collapsedFolds,
      oldLineTokens,
      newLineTokens,
      annotations,
      pendingFallback,
      findByLine,
      find.current,
      hoveredAnnId,
      settings.fontSize,
      settings.lineWrap,
      numColW,
      hostClassName,
      blameEnabled,
      dLines,
    ],
  );
  const rightColumn = useMemo(
    () => (effectiveViewMode === "split" ? renderColumn("right") : null),
    [
      effectiveViewMode,
      splitRows,
      splitFold,
      splitSepIndices,
      splitRowComments,
      collapsedFolds,
      oldLineTokens,
      newLineTokens,
      annotations,
      pendingFallback,
      findByLine,
      find.current,
      hoveredAnnId,
      settings.fontSize,
      settings.lineWrap,
      numColW,
      hostClassName,
      blameEnabled,
      dLines,
    ],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  // Portal host for the blame chip: the selected row's content cell. Re-query
  // whenever the selection changes or a rebuilt row tree may have replaced the
  // node. Same-element results bail out of the state update.
  const [blameChipHost, setBlameChipHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!blameEnabled || !blameSel) {
      setBlameChipHost(null);
      return;
    }
    const selector =
      effectiveViewMode === "split"
        ? `[data-split-side="${blameSel.side}"] td[data-dline="${blameSel.idx}"]`
        : `td[data-dline="${blameSel.idx}"]`;
    setBlameChipHost(
      contentRef.current?.querySelector<HTMLElement>(selector) ?? null,
    );
  }, [
    blameEnabled,
    blameSel,
    effectiveViewMode,
    unifiedBody,
    leftColumn,
    rightColumn,
  ]);

  /** DOM Range for a diff anchor's [startOffset, endOffset) on its side. */
  function rangeForAnchor(a: DiffAnchor): Range | null {
    const root = contentRef.current;
    if (!root) return null;
    const scope =
      effectiveViewMode === "split"
        ? root.querySelector(`[data-split-side="${a.side}"]`)
        : root;
    if (!scope) return null;
    const startLine = dLines[getDiffLineForOffset(a.startOffset, dLines)];
    const endLine =
      dLines[
        getDiffLineForOffset(Math.max(a.startOffset, a.endOffset - 1), dLines)
      ];
    if (!startLine || !endLine) return null;
    const startCell = scope.querySelector(`td[data-dline="${startLine.idx}"]`);
    const endCell = scope.querySelector(`td[data-dline="${endLine.idx}"]`);
    if (!startCell || !endCell) return null;
    const s = textBoundaryAt(startCell, a.startOffset - startLine.flatOffset);
    const e = textBoundaryAt(endCell, a.endOffset - endLine.flatOffset);
    if (!s || !e) return null;
    const range = document.createRange();
    try {
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    } catch {
      return null;
    }
    return range;
  }

  // Paint the pending-comment highlight (see pendingHl at module scope).
  // Re-anchored after any row-tree rebuild, which replaces the text nodes the
  // Range points into.
  const pendingRangeRef = useRef<Range | null>(null);
  useLayoutEffect(() => {
    if (!pendingHl) return;
    if (pendingRangeRef.current) {
      pendingHl.delete(pendingRangeRef.current);
      pendingRangeRef.current = null;
    }
    if (!pending) return;
    const range = rangeForAnchor(pending.data);
    if (range) {
      pendingHl.add(range);
      pendingRangeRef.current = range;
    }
    // rangeForAnchor reads only dep-covered values (effectiveViewMode, dLines)
    // plus refs, so the closure itself isn't a meaningful dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pending,
    effectiveViewMode,
    dLines,
    unifiedBody,
    leftColumn,
    rightColumn,
  ]);
  useEffect(
    () => () => {
      if (pendingHl && pendingRangeRef.current) {
        pendingHl.delete(pendingRangeRef.current);
      }
    },
    [],
  );

  function renderSplit() {
    return (
      <div className="flex">
        {/* rounded-l/r-lg matches the container's rounded-lg so the inset focus
            ring follows the curve at the outer corners (it stays square at the
            inner divider, which is correct). */}
        <div className="min-w-0 flex-1 rounded-l-lg border-r border-[var(--border)] focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent)]">
          {leftColumn}
        </div>
        {showGutter && renderGutter()}
        <div className="min-w-0 flex-1 rounded-r-lg focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent)]">
          {rightColumn}
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
      <DiffSettingsControls
        settings={settings}
        onSettingsChange={onSettingsChange}
        isFirstVersion={isFirstVersion}
        variant={settingsVariant}
        portalTarget={settingsPortalTarget}
        separatorsCustomized={expandedSeparators.size > 0}
        onCollapseSeparators={() => setExpandedSeparators(new Set())}
      />

      <div
        ref={contentRef}
        // Opt into the desktop tight drag-selection paint (live-selection-
        // mirror.ts): native ::selection is suppressed here and mirrored onto a
        // custom highlight so the drag reads tight, matching the committed
        // per-character selection. Inert on web (no matching CSS/mirror), which
        // keeps its native selection.
        data-tight-selection=""
        onMouseDown={lockSelectionToStartSide}
        onClick={(e) => {
          if (!mergeEnabled) return;
          // Don't trigger on a drag-select.
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim().length > 0)
            return;
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
                // While a button is held the pointer is dragging a selection, not
                // hovering — recomputing the hunk hover here flips state as the
                // drag crosses hunk boundaries, re-rendering the whole (un-
                // virtualized) diff mid-gesture and making selection lag. Hover
                // only needs to track a free-moving pointer, so bail when buttons
                // are down; the next plain move after mouseup restores it.
                if (e.buttons !== 0) return;
                // `undefined` → cursor is on the box itself; keep it revealed
                // (moving onto it must NOT clear the hover, or it would blink).
                if (effectiveViewMode === "split") {
                  const h = hunkHoverFromEvent(e);
                  if (h !== undefined) applyHunkHover(h);
                  return;
                }
                let el: HTMLElement | null = e.target as HTMLElement | null;
                while (el && !el.hasAttribute("data-dline")) {
                  if (el.hasAttribute("data-hunk-control")) return;
                  if (el === contentRef.current) {
                    applyChangeHover(null);
                    return;
                  }
                  el = el.parentElement;
                }
                if (!el) return;
                const lineIdx = parseInt(el.getAttribute("data-dline")!);
                const changeIdx = lineToChange.get(lineIdx);
                applyChangeHover(changeIdx ?? null);
              }
            : undefined
        }
        onMouseLeave={
          hunkActionsEnabled
            ? () => {
                applyChangeHover(null);
                applyHunkHover(null);
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
        {effectiveViewMode === "unified" ? unifiedBody : renderSplit()}
        {blameChipHost && createPortal(renderBlameChipContent(), blameChipHost)}
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
        {hunkActionsEnabled && hunkActions && effectiveViewMode !== "split" && (
          // Always mounted, display:none until applyChangeHover positions and
          // reveals it. Buttons resolve the hovered change through the ref at
          // click time — the hover never passes through React state.
          <div
            ref={unifiedCtrlRef}
            data-hunk-control
            contentEditable={false}
            className="absolute left-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 select-none items-center gap-1"
            style={{ display: "none", top: 0 }}
          >
            {hunkActions.isStaged ? (
              <button
                onClick={() => {
                  const i = hoverChangeRef.current;
                  const c = i == null ? undefined : changes[i];
                  if (c) hunkActions.onUnstage(changeRange(c));
                }}
                title="Unstage this hunk"
                className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--bg-surface-hover)]"
              >
                − Unstage hunk
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    const i = hoverChangeRef.current;
                    const c = i == null ? undefined : changes[i];
                    if (c) hunkActions.onRevert(changeRange(c));
                  }}
                  title="Revert this hunk"
                  className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--removed-text)]"
                >
                  ↺ Revert
                </button>
                <button
                  onClick={() => {
                    const i = hoverChangeRef.current;
                    const c = i == null ? undefined : changes[i];
                    if (c) hunkActions.onStage(changeRange(c));
                  }}
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

      {/* Popovers are position:fixed with viewport coordinates, so they must
          escape any ancestor that establishes a containing block for fixed
          descendants — the chat message row wrapping a plan card carries
          `content-visibility:auto` (paint containment), which would otherwise
          re-anchor `top`/`left` to the row and drop the popover well below the
          selection. Portaling to <body> keeps the math viewport-relative. */}
      {pending &&
        createPortal(
          <CommentPopover
            position={pending.position}
            selectedText={pending.selectedText}
            onSubmit={selection.submit}
            onClose={selection.cancel}
          />,
          document.body,
        )}
      {editing &&
        createPortal(
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
          />,
          document.body,
        )}
    </div>
  );
}
