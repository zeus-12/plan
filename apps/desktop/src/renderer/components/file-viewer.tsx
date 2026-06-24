import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  highlightPerLine,
  languageFromPath,
  useActiveShikiTheme,
  useShikiReady,
  type SyntaxToken,
} from "@plan/shared/lib/highlight";
import type { Annotation } from "@plan/shared/lib/store";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { useCommentSelection } from "@plan/shared/lib/use-comment-selection";
import { useTextFind } from "@plan/shared/lib/use-text-find";
import { FindWidget } from "@plan/shared/components/find-widget";
import { cn } from "@plan/shared/lib/utils";
import { FileIcon } from "./file-icon";
import { ImageLightbox } from "./image-lightbox";

const LINE_HEIGHT = 20;
const CONTENT_PAD_LEFT = 12; // matches the content cell's `pl-3`
// Stable empty token array — `perLine[i]` resolving to undefined renders plain.
const EMPTY_PER_LINE: SyntaxToken[][] = [];
const POPOVER_VIEWPORT_PAD = 380;

/**
 * Editor surface: render the file in a real (read-only) caret/keyboard editor
 * — a transparent textarea overlaid on the highlighted layer — so the file
 * behaves like a VS Code pane (blinking caret, arrow-key navigation,
 * shift+arrow selection). Flip {@link ALLOW_TYPING} to make it editable later.
 */
const ENABLE_EDITOR_CARET = true;
/** When false the editor surface is read-only (caret + selection, no typing). */
const ALLOW_TYPING = false;
/**
 * Above this many lines the editor surface (which can't virtualize — the
 * textarea must hold the whole file) is skipped in favor of the virtualized
 * read-only view. Keeps huge files fast at the cost of the caret on those.
 */
const EDITOR_MAX_LINES = 4000;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);

function isImagePath(p: string): boolean {
  const i = p.lastIndexOf(".");
  return i !== -1 && IMAGE_EXTS.has(p.slice(i + 1).toLowerCase());
}

interface Props {
  encoded: string;
  /** Project-relative POSIX path. */
  path: string;
  /** Comments for THIS file (from the shared per-project annotation store). */
  annotations: Annotation[];
  /** Selection → comment. Offsets/lines are computed by this viewer. */
  onAddAnnotation: (
    selectedText: string,
    startOffset: number,
    endOffset: number,
    startLine: number,
    endLine: number,
    comment: string
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  /** False while the Files pane is hidden — disables the global selection hook. */
  active: boolean;
  /** A Search-tab hit to scroll to and highlight (1-based line + char range). */
  revealTarget?: {
    line: number;
    colStart: number;
    colEnd: number;
    nonce: number;
  } | null;
}

interface Loaded {
  text: string;
  truncated: boolean;
  binary: boolean;
}

/** A resolved selection in the file, in absolute character offsets + lines. */
interface FileAnchor {
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

interface EditingComment {
  id: string;
  selectedText: string;
  comment: string;
  top: number;
  left: number;
}

/** A character-range highlight within one line, in line-local offsets. */
interface Hl {
  s: number;
  e: number;
  kind: "ann" | "pending" | "search" | "find" | "find-current";
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Render one line, merging syntax tokens with character-precise highlight
 * ranges. Highlights tint only the selected characters (not the whole row), so
 * a partial selection reads like an editor selection.
 */
function lineNodes(
  line: string,
  tokens: SyntaxToken[] | undefined,
  hls: Hl[]
): ReactNode {
  const hasTokens = !!tokens && tokens.length > 0;
  if (!hasTokens && hls.length === 0) return line.length ? line : " ";

  const bounds = new Set<number>([0, line.length]);
  if (hasTokens) {
    for (const t of tokens!) {
      bounds.add(t.start);
      bounds.add(t.end);
    }
  }
  for (const h of hls) {
    bounds.add(h.s);
    bounds.add(h.e);
  }
  const sorted = [...bounds]
    .filter((b) => b >= 0 && b <= line.length)
    .sort((a, b) => a - b);

  const findTok = (p: number) =>
    hasTokens ? tokens!.find((t) => t.start <= p && p < t.end) ?? null : null;
  const findHl = (p: number) => hls.find((h) => h.s <= p && p < h.e) ?? null;

  const parts: ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (s >= e) continue;
    const slice = line.slice(s, e);
    const tok = findTok(s);
    const hl = findHl(s);

    const style: Record<string, string | number> = {};
    const cls: string[] = [];
    if (tok?.color) {
      cls.push("shiki-tok");
      style["--shiki-color"] = tok.color;
    }
    if (tok?.italic) style.fontStyle = "italic";
    if (tok?.bold) style.fontWeight = 600;
    if (hl) {
      if (hl.kind === "ann") style.background = "var(--highlight-bg)";
      else if (hl.kind === "search")
        style.background = "var(--search-match-bg, rgba(250,204,21,0.45))";
      else if (hl.kind === "find")
        style.background = "var(--find-match-bg, rgba(234,179,8,0.32))";
      else if (hl.kind === "find-current") {
        style.background = "var(--find-current-bg, rgba(249,115,22,0.6))";
        style.outline = "1px solid var(--find-current-border, #f59e0b)";
      } else style.background = "var(--selection-bg)";
      cls.push("rounded-sm");
    }

    parts.push(
      <span
        key={s}
        className={cls.join(" ") || undefined}
        style={style as React.CSSProperties}
      >
        {slice}
      </span>
    );
  }
  return <>{parts}</>;
}

export function FileViewer({
  encoded,
  path,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  active,
  revealTarget,
}: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">("loading");
  const [editing, setEditing] = useState<EditingComment | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgBroken, setImgBroken] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  // The Search-tab match to paint (absolute char offsets), cleared when the
  // user starts their own selection so it doesn't linger as a fake highlight.
  const [revealRange, setRevealRange] = useState<{ s: number; e: number } | null>(
    null,
  );
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  const isImage = useMemo(() => isImagePath(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    setImageUrl(null);
    setImgBroken(false);
    setLightbox(false);
    // Images load straight from disk via a file:// URL (no bytes through JS),
    // the same way transcript images render.
    if (isImage) {
      window.electronAPI.projectFilePath(encoded, path).then((abs) => {
        if (cancelled) return;
        if (!abs) {
          setStatus("missing");
        } else {
          setImageUrl(`file://${encodeURI(abs)}`);
          setStatus("ok");
        }
      });
      return () => {
        cancelled = true;
      };
    }
    window.electronAPI.readProjectFile(encoded, path).then((res) => {
      if (cancelled) return;
      if (!res) {
        setStatus("missing");
      } else {
        setData(res);
        setStatus("ok");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [encoded, path, isImage]);

  const language = useMemo(() => languageFromPath(path) ?? "plaintext", [path]);
  const text = data?.text ?? "";

  // In-view find (⌘F). Surface paints `find.matches` and scrolls `find.current`.
  const find = useTextFind(text);
  const [findReveal, setFindReveal] = useState(0);
  const lines = useMemo(() => text.split("\n"), [text]);
  // Tokenizing a whole file is a synchronous main-thread cost that, on the
  // urgent (switch) render, froze the pane until shiki finished. Defer it: the
  // file paints instantly as plain text, then a low-priority render fills in
  // colors. `highlightStale` keeps stale tokens (from the previous file) off
  // the new lines during the one frame the deferred value lags behind.
  const deferredText = useDeferredValue(text);
  const highlightStale = deferredText !== text;
  const perLine = useMemo(
    () =>
      data && !data.binary && !highlightStale
        ? highlightPerLine(text, language)
        : EMPTY_PER_LINE,
    // shikiReady / shikiTheme are deps so colors appear once the highlighter
    // finishes loading and re-tokenize when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, text, highlightStale, language, shikiReady, shikiTheme]
  );

  // Character offset where each line begins — lets a line/selection map back to
  // the absolute offsets the Annotation shape stores.
  const lineStarts = useMemo(() => {
    const arr = new Array<number>(lines.length);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      arr[i] = acc;
      acc += lines[i].length + 1;
    }
    return arr;
  }, [lines]);

  const lineOfOffset = useCallback(
    (offset: number): number => {
      // lineStarts is ascending — last index whose start is <= offset.
      let lo = 0;
      let hi = lineStarts.length - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= offset) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    },
    [lineStarts]
  );

  const editorMode =
    ENABLE_EDITOR_CARET &&
    status === "ok" &&
    !isImage &&
    !!data &&
    !data.binary &&
    lines.length <= EDITOR_MAX_LINES;

  // The comment anchored at each line's first row (for the gutter marker).
  const firstOf = useMemo(() => {
    const map = new Map<number, Annotation>();
    for (const an of annotations) {
      const s = an.context?.startLine;
      if (!s) continue;
      if (!map.has(s)) map.set(s, an);
    }
    return map;
  }, [annotations]);

  /* ── Monospace metrics (for editor caret/popover alignment) ───── */

  const [charWidth, setCharWidth] = useState(8);
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width / 40;
    if (w > 0) setCharWidth(w);
  }, [shikiReady, status]);

  const gutterCh = Math.max(2, String(lines.length).length) + 1;
  const gutterChCount = gutterCh + 2; // matches the gutter span's `ch` width
  const gutterWidthPx = gutterChCount * charWidth;

  /* ── Editor (textarea) selection state ────────────────────────── */

  // Live selection inside the editor textarea, in absolute char offsets. Drives
  // the visible highlight (the textarea's own selection is hidden via CSS).
  const [editorSel, setEditorSel] = useState<{ start: number; end: number } | null>(
    null
  );
  const [editorPopover, setEditorPopover] = useState<
    { top: number; left: number } | null
  >(null);

  useEffect(() => {
    // Reset selection when the open file changes.
    setEditorSel(null);
    setEditorPopover(null);
  }, [encoded, path]);

  const caretPopoverPos = useCallback(
    (offset: number) => {
      const parent = parentRef.current;
      if (!parent) return { top: 0, left: 0 };
      const rect = parent.getBoundingClientRect();
      const ln = lineOfOffset(offset);
      const col = offset - lineStarts[ln];
      const x =
        rect.left +
        gutterWidthPx +
        CONTENT_PAD_LEFT +
        col * charWidth -
        parent.scrollLeft;
      const y = rect.top + (ln + 1) * LINE_HEIGHT - parent.scrollTop;
      return {
        top: y + 8,
        left: Math.max(
          8,
          Math.min(x, window.innerWidth - POPOVER_VIEWPORT_PAD)
        ),
      };
    },
    [lineOfOffset, lineStarts, gutterWidthPx, charWidth]
  );

  const ensureCaretVisible = useCallback(
    (offset: number) => {
      const parent = parentRef.current;
      if (!parent) return;
      const ln = lineOfOffset(offset);
      const top = ln * LINE_HEIGHT;
      const bottom = top + LINE_HEIGHT;
      if (top < parent.scrollTop) parent.scrollTop = top;
      else if (bottom > parent.scrollTop + parent.clientHeight)
        parent.scrollTop = bottom - parent.clientHeight;
    },
    [lineOfOffset]
  );

  // Read the textarea's current selection into our state (drives the visible
  // highlight; the textarea's own selection is hidden via CSS).
  const readEditorSel = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return null;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setEditorSel({ start, end });
    return { start, end };
  }, []);

  /* ── DOM selection (virtualized read-only fallback) ───────────── */

  // Map a selection endpoint back to the 0-based line index of its row.
  const lineIndexOf = useCallback((node: Node | null): number | null => {
    let el: Element | null =
      node instanceof Element ? node : node?.parentElement ?? null;
    while (el && el !== parentRef.current) {
      const attr = el.getAttribute("data-line-index");
      if (attr != null) return parseInt(attr, 10);
      el = el.parentElement;
    }
    return null;
  }, []);

  // The content `<span>` an endpoint lives in (so the offset walk skips the
  // gutter's line-number text).
  const contentElOf = useCallback((node: Node | null): Element | null => {
    let el: Element | null =
      node instanceof Element ? node : node?.parentElement ?? null;
    while (el && el !== parentRef.current) {
      if (el.hasAttribute("data-line-content")) return el;
      el = el.parentElement;
    }
    return null;
  }, []);

  const resolveSelection = useCallback(
    (range: Range, selection: Selection) => {
      const root = parentRef.current;
      if (!root) return null;
      if (
        !root.contains(range.startContainer) ||
        !root.contains(range.endContainer)
      )
        return null;
      const sel = selection.toString();
      if (!sel.trim()) return null;
      const aIdx = lineIndexOf(range.startContainer);
      const bIdx = lineIndexOf(range.endContainer);
      const aEl = contentElOf(range.startContainer);
      const bEl = contentElOf(range.endContainer);
      if (aIdx == null || bIdx == null || !aEl || !bEl) return null;

      let startOffset =
        lineStarts[aIdx] +
        offsetWithinContent(aEl, range.startContainer, range.startOffset);
      let endOffset =
        lineStarts[bIdx] +
        offsetWithinContent(bEl, range.endContainer, range.endOffset);
      if (startOffset > endOffset)
        [startOffset, endOffset] = [endOffset, startOffset];

      return {
        data: {
          startLine: Math.min(aIdx, bIdx) + 1,
          endLine: Math.max(aIdx, bIdx) + 1,
          startOffset,
          endOffset,
        },
        selectedText: sel,
      };
    },
    [lineIndexOf, contentElOf, lineStarts]
  );

  const createAnnotation = useCallback(
    (data: FileAnchor, selectedText: string, comment: string) => {
      onAddAnnotation(
        selectedText,
        data.startOffset,
        data.endOffset,
        data.startLine,
        data.endLine,
        comment
      );
    },
    [onAddAnnotation]
  );

  const selection = useCommentSelection<FileAnchor>({
    enabled: active && status === "ok" && !editorMode,
    resolve: resolveSelection,
    onCreate: createAnnotation,
  });
  const pending = selection.pending;

  // Uncommitted highlight range. In editor mode the textarea's own (translucent)
  // native selection is shown live during the drag — drawing our own on top of
  // that would double it up and re-render every drag tick (the old lag). But the
  // moment the comment popover opens it steals focus, and a blurred textarea
  // hides its selection — so once the popover is up we draw a persistent
  // highlight (one render, not per-tick) to hold the selection visible while the
  // user types, exactly like the diff/plan/chat surfaces.
  const activeRange = useMemo<{ s: number; e: number } | null>(() => {
    if (editorMode) {
      if (editorPopover && editorSel && editorSel.start !== editorSel.end)
        return {
          s: Math.min(editorSel.start, editorSel.end),
          e: Math.max(editorSel.start, editorSel.end),
        };
      return null;
    }
    return pending
      ? { s: pending.data.startOffset, e: pending.data.endOffset }
      : null;
  }, [editorMode, editorPopover, editorSel, pending]);

  // Opening the editor for an existing comment dismisses any in-flight selection.
  useEffect(() => {
    if (pending) {
      setEditing(null);
      setRevealRange(null);
    }
  }, [pending]);

  // A real selection in the editor surface supersedes the Search reveal.
  useEffect(() => {
    if (editorSel && editorSel.start !== editorSel.end) setRevealRange(null);
  }, [editorSel]);

  // Bucket find matches by their start line so per-row highlighting is O(1).
  const findByLine = useMemo(() => {
    const map = new Map<number, { s: number; e: number; current: boolean }[]>();
    if (!find.open) return map;
    for (let i = 0; i < find.matches.length; i++) {
      const m = find.matches[i];
      const ln = lineOfOffset(m.start);
      const entry = { s: m.start, e: m.end, current: i === find.current };
      const arr = map.get(ln);
      if (arr) arr.push(entry);
      else map.set(ln, [entry]);
    }
    return map;
  }, [find.open, find.matches, find.current, lineOfOffset]);

  const hlsForLine = useCallback(
    (lineIdx: number): Hl[] => {
      const ls = lineStarts[lineIdx];
      const le = ls + lines[lineIdx].length;
      const out: Hl[] = [];
      for (const a of annotations) {
        if (a.startOffset < le && a.endOffset > ls) {
          out.push({
            s: Math.max(a.startOffset, ls) - ls,
            e: Math.min(a.endOffset, le) - ls,
            kind: "ann",
          });
        }
      }
      if (activeRange && activeRange.s < le && activeRange.e > ls) {
        out.push({
          s: Math.max(activeRange.s, ls) - ls,
          e: Math.min(activeRange.e, le) - ls,
          kind: "pending",
        });
      }
      if (revealRange && revealRange.s < le && revealRange.e > ls) {
        out.push({
          s: Math.max(revealRange.s, ls) - ls,
          e: Math.min(revealRange.e, le) - ls,
          kind: "search",
        });
      }
      for (const f of findByLine.get(lineIdx) ?? []) {
        if (f.s < le && f.e > ls) {
          out.push({
            s: Math.max(f.s, ls) - ls,
            e: Math.min(f.e, le) - ls,
            kind: f.current ? "find-current" : "find",
          });
        }
      }
      return out.sort((a, b) => a.s - b.s);
    },
    [annotations, activeRange, revealRange, findByLine, lineStarts, lines]
  );

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  // Jump to + highlight a Search-tab hit. Re-runs on `nonce` so re-clicking the
  // same line scrolls again. Waits for the file to load before scrolling.
  const revealNonce = revealTarget?.nonce;
  useEffect(() => {
    if (!revealTarget || status !== "ok") return;
    const idx = Math.min(Math.max(revealTarget.line - 1, 0), lines.length - 1);
    const ls = lineStarts[idx] ?? 0;
    setRevealRange({ s: ls + revealTarget.colStart, e: ls + revealTarget.colEnd });
    virtualizer.scrollToIndex(idx, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, status]);

  // ⌘F opens the find widget for the visible file, seeded with any selection.
  const searchable = status === "ok" && !isImage && !!data && !data.binary;
  useEffect(() => {
    if (!active || !searchable) return;
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
  }, [active, searchable, find]);

  // Keep the active match scrolled into view as the user steps through.
  useEffect(() => {
    if (!find.open || find.current < 0) return;
    const m = find.matches[find.current];
    if (!m) return;
    virtualizer.scrollToIndex(lineOfOffset(m.start), { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.current, find.matches]);

  const openEditor = useCallback(
    (an: Annotation, e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      selection.cancel();
      setEditorPopover(null);
      setEditing({
        id: an.id,
        selectedText: an.selectedText,
        comment: an.comment,
        top: rect.bottom + 8,
        left: rect.left,
      });
    },
    [selection]
  );

  const submitEditorComment = useCallback(
    (comment: string) => {
      if (!editorSel || editorSel.start === editorSel.end) return;
      const s = Math.min(editorSel.start, editorSel.end);
      const e = Math.max(editorSel.start, editorSel.end);
      onAddAnnotation(
        text.slice(s, e),
        s,
        e,
        lineOfOffset(s) + 1,
        lineOfOffset(e) + 1,
        comment
      );
      setEditorPopover(null);
      const ta = textareaRef.current;
      if (ta) ta.setSelectionRange(e, e);
      setEditorSel({ start: e, end: e });
    },
    [editorSel, text, onAddAnnotation, lineOfOffset]
  );

  /* ── Gutter cell (line number + comment marker) ──────────────── */

  function gutterCell(lineNo: number) {
    const anchored = firstOf.get(lineNo);
    return (
      <span
        className="sticky left-0 z-10 flex shrink-0 select-none items-center justify-end gap-1 bg-[var(--bg)] pr-3 pl-3 text-right text-[var(--text-tertiary)]"
        // Pixel width (not `ch`) so it matches the textarea overlay's measured
        // metrics exactly — otherwise the caret/selection drift from the glyphs.
        style={{ width: gutterWidthPx }}
      >
        {anchored && (
          <button
            onClick={(e) => openEditor(anchored, e)}
            aria-label="Edit comment"
            title={anchored.comment}
            className="flex h-2 w-2 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] transition-transform hover:scale-125"
          />
        )}
        <span>{lineNo}</span>
      </span>
    );
  }

  const newCommentPopover = editorMode
    ? editorPopover && editorSel && editorSel.start !== editorSel.end
      ? {
          position: editorPopover,
          selectedText: text.slice(
            Math.min(editorSel.start, editorSel.end),
            Math.max(editorSel.start, editorSel.end)
          ),
          onSubmit: submitEditorComment,
          onClose: () => {
            setEditorPopover(null);
            const ta = textareaRef.current;
            if (ta && editorSel) ta.setSelectionRange(editorSel.end, editorSel.end);
            setEditorSel((s) => (s ? { start: s.end, end: s.end } : null));
          },
        }
      : null
    : pending
      ? {
          position: pending.position,
          selectedText: pending.selectedText,
          onSubmit: selection.submit,
          onClose: selection.cancel,
        }
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Hidden ruler: 40 mono chars → per-character width for caret math. */}
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute font-[family-name:var(--font-mono)] text-[13px] leading-[20px]"
        style={{ whiteSpace: "pre" }}
      >
        0000000000000000000000000000000000000000
      </span>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2 font-[family-name:var(--font-mono)] text-[11px]">
        <FileIcon name={basename(path)} />
        <span className="truncate text-[var(--text)]">{basename(path)}</span>
        <span className="truncate text-[var(--text-tertiary)]">{path}</span>
        {data?.truncated && (
          <span className="ml-auto shrink-0 text-[var(--text-tertiary)]">
            truncated
          </span>
        )}
      </div>

      {status === "loading" ? (
        <Centered>Loading…</Centered>
      ) : status === "missing" ? (
        <Centered>File not found</Centered>
      ) : isImage ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          {imageUrl && !imgBroken ? (
            <img
              src={imageUrl}
              alt={basename(path)}
              onClick={() => setLightbox(true)}
              onError={() => setImgBroken(true)}
              className="max-h-full max-w-full cursor-zoom-in rounded-md border border-[var(--border)] object-contain"
            />
          ) : (
            <Centered>Image unavailable</Centered>
          )}
        </div>
      ) : data?.binary ? (
        <Centered>Binary file — can&apos;t preview</Centered>
      ) : (
        /*
         * One virtualized highlighted layer for both modes. In editor mode a
         * single full-height textarea overlays it for the caret/keyboard model
         * (the textarea is one native control, so it stays cheap even for big
         * files — only the visible highlighted lines are real DOM).
         */
        <div className="relative min-h-0 flex-1">
        <div
          ref={parentRef}
          className="absolute inset-0 overflow-auto font-[family-name:var(--font-mono)] text-[13px] leading-[20px]"
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "max-content",
              minWidth: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const line = lines[vi.index];
              return (
                <div
                  key={vi.key}
                  data-line-index={vi.index}
                  className="absolute left-0 top-0 flex w-full"
                  style={{
                    height: LINE_HEIGHT,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {gutterCell(vi.index + 1)}
                  <span
                    data-line-content
                    className={cn(
                      "whitespace-pre pl-3 pr-6 text-[var(--text)]",
                      // In editor mode the textarea owns selection; elsewhere the
                      // content opts into native text selection.
                      !editorMode && "select-text [cursor:text]"
                    )}
                  >
                    {lineNodes(line, perLine[vi.index], hlsForLine(vi.index))}
                  </span>
                </div>
              );
            })}
            {editorMode && (
              <textarea
                ref={textareaRef}
                className="file-editor-input absolute bottom-0 top-0 resize-none border-0 bg-transparent p-0 text-[13px] leading-[20px] outline-none"
                style={{
                  left: gutterWidthPx,
                  right: 0,
                  paddingLeft: CONTENT_PAD_LEFT,
                  fontFamily: "var(--font-mono)",
                  color: "transparent",
                  caretColor: "var(--text)",
                  whiteSpace: "pre",
                  overflow: "hidden",
                }}
                value={text}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={`${basename(path)} contents`}
                // Editable (so the caret actually shows — readOnly hides it), but
                // every mutation is cancelled. Flip ALLOW_TYPING to make it a real
                // editor later; the controlled value is the second line of defense.
                onChange={() => {}}
                onBeforeInput={(e) => {
                  if (!ALLOW_TYPING) e.preventDefault();
                }}
                onPaste={(e) => {
                  if (!ALLOW_TYPING) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!ALLOW_TYPING) e.preventDefault();
                }}
                // No onSelect: the native selection renders live on its own.
                // Reading it into React state per drag-tick is what made the old
                // selection lag — so we only settle it on release / key-up.
                onMouseUp={() => {
                  const s = readEditorSel();
                  if (!s) return;
                  if (s.start !== s.end)
                    setEditorPopover(caretPopoverPos(Math.max(s.start, s.end)));
                  else setEditorPopover(null);
                }}
                onKeyUp={(e) => {
                  const s = readEditorSel();
                  if (!s) return;
                  ensureCaretVisible(s.end);
                  if (e.shiftKey && s.start !== s.end)
                    setEditorPopover(caretPopoverPos(Math.max(s.start, s.end)));
                  else if (s.start === s.end) setEditorPopover(null);
                }}
              />
            )}
          </div>
        </div>
          <FindWidget find={find} revealTrigger={findReveal} />
        </div>
      )}

      {newCommentPopover && (
        <CommentPopover
          position={newCommentPopover.position}
          selectedText={newCommentPopover.selectedText}
          onSubmit={newCommentPopover.onSubmit}
          onClose={newCommentPopover.onClose}
        />
      )}
      {editing && (
        <CommentPopover
          position={{ top: editing.top, left: editing.left }}
          selectedText={editing.selectedText}
          initialComment={editing.comment}
          submitLabel="Update"
          onSubmit={(comment) => {
            onUpdateAnnotation(editing.id, comment);
            setEditing(null);
          }}
          onDelete={() => {
            onRemoveAnnotation(editing.id);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {lightbox && imageUrl && (
        <ImageLightbox src={imageUrl} onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}

/** Sum text length within a content span up to (node, nodeOffset). */
function offsetWithinContent(
  contentEl: Element,
  node: Node,
  nodeOffset: number
): number {
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let within = 0;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    if (cur === node) return within + nodeOffset;
    within += cur.textContent?.length ?? 0;
    cur = walker.nextNode();
  }
  return within;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
