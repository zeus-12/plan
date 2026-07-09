import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { NotebookPen } from "lucide-react";
import {
  codeBracketPositions,
  highlightPerLine,
  languageFromPath,
  SYNC_HIGHLIGHT_MAX_CHARS,
  useActiveShikiTheme,
  useShikiReady,
  type SyntaxToken,
} from "@plan/shared/lib/highlight";
import {
  collapsedRangesContaining,
  foldRangeMap,
  hiddenLineSet,
} from "@plan/shared/lib/folding";
import {
  bracketColorsByLine,
  type BracketMark,
} from "@plan/shared/lib/brackets";
import {
  useFoldEngine,
  useFolds,
  type CodeSymbol,
} from "@plan/shared/code-folding";
import Fuse from "fuse.js";
import { CommandPalette, type PaletteItem } from "./command-palette";
import type { Annotation } from "@plan/shared/lib/store";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { useCommentSelection } from "@plan/shared/lib/use-comment-selection";
import { useTextFind } from "@plan/shared/lib/use-text-find";
import { FindWidget } from "@plan/shared/components/find-widget";
import { buildDocUrl } from "@plan/shared/lib/doc-share-url";
import { cn } from "@plan/shared/lib/utils";
import { basename } from "@plan/shared/lib/path";
import { isImagePath } from "../lib/image-paths";
import { FileIcon } from "./file-icon";
import { ImageLightbox } from "./image-lightbox";
import { useWorktreeRevision } from "../lib/worktree-revision";
import { blameLineInfo, tagBlame, type TextBlame } from "../lib/blame";
import { useBlameCard } from "../lib/use-blame-card";

const LINE_HEIGHT = 20;
const CONTENT_PAD_LEFT = 12; // matches the content cell's `pl-3`
/** Most nested scope headers to pin in the sticky-scroll overlay. */
const STICKY_MAX = 8;

/* ── View settings (shared across all file viewers, persisted) ──── */

/** A boolean setting persisted in localStorage and reactive everywhere. */
function makeBoolSetting(key: string, defaultOn: boolean) {
  let value = (() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOn : v === "1";
    } catch {
      return defaultOn;
    }
  })();
  const listeners = new Set<() => void>();
  const set = (on: boolean) => {
    value = on;
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* ignore storage failures */
    }
    listeners.forEach((l) => l());
  };
  const use = () =>
    useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      () => value,
      () => value,
    );
  return { use, set };
}

const stickyScrollSetting = makeBoolSetting("fileViewer.stickyScroll", false);
const bracketColorSetting = makeBoolSetting("fileViewer.bracketColors", true);
const lineWrapSetting = makeBoolSetting("fileViewer.lineWrap", false);
const inlineBlameSetting = makeBoolSetting("fileViewer.inlineBlame", true);
// Stable empty token array — `perLine[i]` resolving to undefined renders plain.
const EMPTY_PER_LINE: SyntaxToken[][] = [];
const POPOVER_VIEWPORT_PAD = 380;

/**
 * Editor surface: a transparent textarea overlaid on the highlighted layer, so
 * the file behaves like a VS Code pane (blinking caret, arrow-key navigation,
 * shift+arrow selection). Typing is enabled per-instance — a `buffer` prop makes
 * it a real editor (the scratchpad); a plain file keeps it read-only (caret +
 * selection only, mutations cancelled). See `allowTyping`.
 */
const ENABLE_EDITOR_CARET = true;
/**
 * Above this many lines the editor surface (which can't virtualize — the
 * textarea must hold the whole file) is skipped in favor of the virtualized
 * read-only view. Keeps huge files fast at the cost of the caret on those.
 */
const EDITOR_MAX_LINES = 4000;

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
    comment: string,
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
    /** Also drop a focused caret on the line (Cmd-P "path:line" jump). */
    focusCaret?: boolean;
  } | null;
  /**
   * When set, the viewer is an EDITABLE in-memory buffer instead of a file read
   * from disk: it never touches `path` on disk, drives its content from
   * `value`/`onChange`, and enables typing. Everything else — highlighting, line
   * numbers, folding, wrap, sticky scroll, find — is the same surface. This is
   * how the scratchpad reuses FileViewer; it's also the seam for making real
   * files editable later. Folding/wrap still suspend the caret overlay (a flat
   * textarea can't mirror that geometry), so editing pauses while folded/wrapped.
   */
  buffer?: EditableBuffer;
}

export interface EditableBuffer {
  value: string;
  onChange: (value: string) => void;
  /** Explicit language (no path-based detection for an in-memory buffer). */
  language: string;
  onLanguageChange: (language: string) => void;
  /** Header title shown in place of the filename. */
  title: string;
  /** Options for the header language picker. */
  languages: readonly { id: string; label: string }[];
  /** ⌘S / "Format" action; omit to hide the button. */
  onFormat?: () => void;
  canFormat?: boolean;
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

/**
 * True when a key/clipboard event is headed for a text-entry control (find
 * input, comment popover, chat composer…) — those own their ⌘A/⌘C, so the
 * file-level select-all must stay out of the way.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Fold toggle: a chevron that points down when open, right when collapsed. */
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

/**
 * Render one line, merging syntax tokens with character-precise highlight
 * ranges. Highlights tint only the selected characters (not the whole row), so
 * a partial selection reads like an editor selection.
 */
function lineNodes(
  line: string,
  tokens: SyntaxToken[] | undefined,
  hls: Hl[],
  brackets?: BracketMark[],
): ReactNode {
  const hasTokens = !!tokens && tokens.length > 0;
  if (!hasTokens && hls.length === 0) return line.length ? line : " ";

  const bracketAt =
    brackets && brackets.length
      ? new Map(brackets.map((b) => [b.col, b.color]))
      : null;

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
  if (bracketAt) {
    for (const b of brackets!) {
      bounds.add(b.col);
      bounds.add(b.col + 1);
    }
  }
  const sorted = [...bounds]
    .filter((b) => b >= 0 && b <= line.length)
    .sort((a, b) => a - b);

  const findTok = (p: number) =>
    hasTokens ? (tokens!.find((t) => t.start <= p && p < t.end) ?? null) : null;
  const findHl = (p: number) => hls.find((h) => h.s <= p && p < h.e) ?? null;

  const parts: ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (s >= e) continue;
    const slice = line.slice(s, e);
    const tok = findTok(s);
    const hl = findHl(s);

    const bcolor = bracketAt?.get(s);
    const style: Record<string, string | number> = {};
    const cls: string[] = [];
    // Bracket-pair colour overrides the syntax token colour for that char.
    if (bcolor) {
      cls.push("shiki-tok");
      style["--shiki-color"] = bcolor;
    } else if (tok?.color) {
      cls.push("shiki-tok");
      style["--shiki-color"] = tok.color;
    }
    if (!bcolor) {
      if (tok?.italic) style.fontStyle = "italic";
      if (tok?.bold) style.fontWeight = 600;
    }
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
      </span>,
    );
  }
  return <>{parts}</>;
}

// Memoized: every open file tab stays mounted (hidden via CSS) so its scroll
// and parsed/highlighted content survive tab switches. Without this, one
// ProjectWorkspace re-render re-rendered every mounted file viewer — the large-
// file cost that made clicking anything lag when several tabs were open.
export const FileViewer = memo(FileViewerImpl);

function FileViewerImpl({
  encoded,
  path,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  active,
  revealTarget,
  buffer,
}: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  // An in-memory buffer is "ok" immediately — there's nothing to read from disk.
  const [status, setStatus] = useState<"loading" | "ok" | "missing">(
    buffer ? "ok" : "loading",
  );
  const [editing, setEditing] = useState<EditingComment | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imgBroken, setImgBroken] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  // The Search-tab match to paint (absolute char offsets), cleared when the
  // user starts their own selection so it doesn't linger as a fake highlight.
  const [revealRange, setRevealRange] = useState<{
    s: number;
    e: number;
  } | null>(null);
  // Start lines of the regions the user has collapsed (VS Code-style folding).
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // A line to scroll to once the layout reflects any fold changes (reveal/find).
  const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(
    null,
  );
  // Sticky scroll: pin enclosing scope headers at the top as you scroll.
  const stickyEnabled = stickyScrollSetting.use();
  const bracketEnabled = bracketColorSetting.use();
  // Line wrap. A file uses the shared, persisted setting; an editable buffer
  // keeps its OWN wrap (default off) instead — otherwise a globally-on wrap would
  // silently disable editing (the flat caret textarea can't mirror wrapped rows,
  // so wrap forces the read-only view). Editing is the whole point of a buffer,
  // so it must not inherit a setting that turns it off.
  const globalLineWrap = lineWrapSetting.use();
  const [bufferWrap, setBufferWrap] = useState(false);
  const lineWrapEnabled = buffer ? bufferWrap : globalLineWrap;
  const setLineWrap = (v: boolean) =>
    buffer ? setBufferWrap(v) : lineWrapSetting.set(v);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Scroll viewport height, tracked so we can reserve empty space below the last
  // line (VS Code "scroll beyond last line"): the final line can scroll up to the
  // top of the viewport instead of being pinned to the bottom edge.
  const [viewportH, setViewportH] = useState(0);
  // Scroll viewport width — the editable overlay stretches to at least this so
  // clicking in the blank space to the right of a short line still lands a caret
  // on that line (the textarea, not dead space, is under the cursor there).
  const [viewportW, setViewportW] = useState(0);
  const settingsRef = useRef<HTMLDivElement>(null);
  // A line to drop the editor caret on after the next reveal scroll settles
  // (set by go-to-symbol so the cursor lands on the jumped-to line).
  const caretRequestRef = useRef<number | null>(null);
  // Go-to-symbol palette (⌘⇧O).
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbols, setSymbols] = useState<CodeSymbol[]>([]);
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  // Inline git blame: per-line authorship shown as a muted trailing annotation
  // on the caret/clicked line, with a hover card for the full commit message.
  const blameEnabled = inlineBlameSetting.use();
  const [blame, setBlame] = useState<TextBlame | null>(null);
  // Active line for the read-only virtualized view (no caret there — a click
  // picks the line). Editor mode derives the line from the caret instead.
  const [clickedLine, setClickedLine] = useState<number | null>(null);
  const {
    card: blameCard,
    hasCard: hasBlameCard,
    chipEnter: blameChipEnter,
    chipLeave: blameChipLeave,
    open: blameOpen,
    close: blameClose,
  } = useBlameCard(encoded, path);

  const isImage = useMemo(() => isImagePath(path), [path]);
  // Bumps when the worktree changes on disk. For text it re-reads; for images
  // it doubles as a cache-buster — Chromium caches a `file://` URL forever, so
  // a re-written image at the same path would otherwise stay stale until the
  // app restarts. Folding the revision into the URL forces a fresh read.
  const revision = useWorktreeRevision(encoded);

  useEffect(() => {
    // In-memory buffer: nothing on disk to read — the content is the prop.
    if (buffer) return;
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
          // `?v=` is ignored by the file loader but makes the URL unique per
          // revision so the browser re-reads instead of serving its cache.
          setImageUrl(`file://${encodeURI(abs)}?v=${revision}`);
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
  }, [encoded, path, isImage, revision]);

  // Blame the exact text being rendered (`--contents`), tagged with it, so
  // authorship structurally cannot drift from what's on screen. Worktree
  // revision bumps flow through `data.text`, so this re-runs only when the
  // content really changed — not for every unrelated file event. Cleared
  // first — stale blame must never paint on new text.
  const blameText =
    blameEnabled && !buffer && data && !data.binary && !data.truncated
      ? data.text
      : null;
  useEffect(() => {
    setBlame(null);
    if (!blameText) return;
    let cancelled = false;
    window.electronAPI.blameContents(encoded, path, blameText).then((r) => {
      if (!cancelled) setBlame(tagBlame(r, blameText));
    });
    return () => {
      cancelled = true;
    };
  }, [encoded, path, blameText]);

  const language = buffer
    ? buffer.language
    : (languageFromPath(path) ?? "plaintext");
  const text = buffer ? buffer.value : (data?.text ?? "");
  // Renderable text content — a loaded non-binary file, or an in-memory buffer.
  // Replaces the raw `!!data && !data.binary` checks so the buffer path lights up
  // highlighting / editing / find the same way a file does.
  const isTextContent = buffer ? true : !!data && !data.binary;
  const allowTyping = !!buffer;

  // In-view find (⌘F). Surface paints `find.matches` and scrolls `find.current`.
  const find = useTextFind(text);
  const [findReveal, setFindReveal] = useState(0);
  const lines = useMemo(() => text.split("\n"), [text]);

  /* ── Code folding ─────────────────────────────────────────────── */

  // Fold ranges come from the active engine (indentation by default; the desktop
  // app can provide the tree-sitter engine via FoldEngineProvider). useFolds
  // handles sync (indentation) and async (worker-parsed) engines uniformly.
  const foldEngine = useFoldEngine();
  const foldRanges = useFolds(foldEngine, text, language);
  const foldByStart = useMemo(() => foldRangeMap(foldRanges), [foldRanges]);
  // Drop any collapsed start that no longer begins a region (file changed under
  // a fold) so stale entries can't hide lines that are no longer part of it.
  const liveCollapsed = useMemo(() => {
    let changed = false;
    const next = new Set<number>();
    for (const s of collapsed) {
      if (foldByStart.has(s)) next.add(s);
      else changed = true;
    }
    return changed ? next : collapsed;
  }, [collapsed, foldByStart]);
  const hiddenLines = useMemo(
    () => hiddenLineSet(liveCollapsed, foldByStart),
    [liveCollapsed, foldByStart],
  );
  // The line indices actually rendered, in order, and the reverse lookup from a
  // line index to its position in that list (-1 when the line is folded away).
  const visibleLineIndices = useMemo(() => {
    if (hiddenLines.size === 0)
      return Array.from({ length: lines.length }, (_, i) => i);
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) if (!hiddenLines.has(i)) out.push(i);
    return out;
  }, [lines.length, hiddenLines]);
  const posOfLine = useMemo(() => {
    const arr = new Int32Array(lines.length).fill(-1);
    for (let p = 0; p < visibleLineIndices.length; p++) {
      arr[visibleLineIndices[p]] = p;
    }
    return arr;
  }, [visibleLineIndices, lines.length]);

  // Close the view-settings popover on any outside click.
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!settingsRef.current?.contains(e.target as Node))
        setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [settingsOpen]);

  const toggleFold = useCallback((startLine: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(startLine)) next.delete(startLine);
      else next.add(startLine);
      return next;
    });
  }, []);

  // Open any collapsed regions hiding `line`, then queue a scroll to it once the
  // re-render has restored the line to the visible set.
  const revealLine = useCallback(
    (line: number) => {
      const toOpen = collapsedRangesContaining(
        line,
        liveCollapsed,
        foldByStart,
      );
      if (toOpen.length) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          for (const s of toOpen) next.delete(s);
          return next;
        });
      }
      setPendingScrollLine(line);
    },
    [liveCollapsed, foldByStart],
  );
  // Tokenizing a whole file is a synchronous main-thread cost. For small/medium
  // files it's sub-frame, so we tokenize on the urgent (switch) render and the
  // file opens already colored — no flash of plain text. Only large files defer:
  // they paint instantly as plain text, then a low-priority render fills in
  // colors so a huge file never freezes the pane. `highlightStale` keeps stale
  // tokens (from the previous file) off the new lines during the lagging frame.
  const deferredText = useDeferredValue(text);
  // While the text is mid-change we render plain (skip the two synchronous Shiki
  // tokenizations — syntax + bracket colors), then color on the low-priority
  // render once `deferredText` catches up. A read-only file only needs this above
  // the sync cap; an editable buffer needs it on EVERY keystroke, else tokenizing
  // the whole doc per keypress makes typing lag even at 50 lines.
  const highlightStale =
    deferredText !== text &&
    (!!buffer || text.length > SYNC_HIGHLIGHT_MAX_CHARS);
  const perLine = useMemo(
    () => {
      if (!isTextContent) return EMPTY_PER_LINE;
      // Buffer (incremental edits): tokenize the DEFERRED text. Keystrokes never
      // block on tokenization (it runs on the low-priority render), and the
      // colors from the last settled text stay painted while typing — no flash to
      // plain black between keystrokes. A file switch instead blanks via
      // highlightStale so the previous file's colors never paint the new one.
      if (buffer) return highlightPerLine(deferredText, language);
      return highlightStale ? EMPTY_PER_LINE : highlightPerLine(text, language);
    },
    // shikiReady / shikiTheme are deps so colors appear once the highlighter
    // finishes loading and re-tokenize when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      buffer,
      data,
      text,
      deferredText,
      highlightStale,
      language,
      shikiReady,
      shikiTheme,
    ],
  );

  // Bracket-pair colours per line. Real brackets are identified by the
  // tokenizer's TextMate scopes (codeBracketPositions) — so brackets inside
  // strings/comments/regex are excluded and template `${…}` braces included —
  // then coloured by nesting depth. Skipped for very large files (a second
  // scope-aware tokenization), matching the syntax-highlight size gate.
  const EMPTY_BRACKETS = useMemo(() => new Map<number, BracketMark[]>(), []);
  const bracketByLine = useMemo(
    () => {
      if (!bracketEnabled || !shikiReady || !isTextContent)
        return EMPTY_BRACKETS;
      // Same deferred-vs-blank split as perLine, so bracket colors also persist
      // while typing a buffer instead of flashing off.
      if (buffer)
        return bracketColorsByLine(
          codeBracketPositions(deferredText, language),
        );
      return highlightStale
        ? EMPTY_BRACKETS
        : bracketColorsByLine(codeBracketPositions(text, language));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      bracketEnabled,
      buffer,
      text,
      deferredText,
      language,
      shikiReady,
      shikiTheme,
      data,
      highlightStale,
      EMPTY_BRACKETS,
    ],
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
    [lineStarts],
  );

  // ── Fold-aware editing (buffer only) ───────────────────────────────────────
  // A textarea can't hide rows, so when a buffer has folds the overlay shows only
  // the VISIBLE lines (`displayText`) — which lines up 1:1 with the rendered
  // layer — and every edit is spliced back into the full text by offset, leaving
  // the folded lines untouched. With no folds, `displayText` IS the full text and
  // `commit` is a plain passthrough, so the unfolded path is unchanged.
  const folded = !!buffer && visibleLineIndices.length < lines.length;
  const displayText = useMemo(
    () => (folded ? visibleLineIndices.map((i) => lines[i]).join("\n") : text),
    [folded, visibleLineIndices, lines, text],
  );
  // Start offset of each visible line within `displayText`.
  const displayLineStarts = useMemo(() => {
    const arr = new Array<number>(visibleLineIndices.length);
    let acc = 0;
    for (let p = 0; p < visibleLineIndices.length; p++) {
      arr[p] = acc;
      acc += lines[visibleLineIndices[p]].length + 1;
    }
    return arr;
  }, [visibleLineIndices, lines]);
  // (row, col) of a displayText offset — the row is also its visual line.
  const displayRowCol = useCallback(
    (dOff: number): { row: number; col: number } => {
      let lo = 0;
      let hi = displayLineStarts.length - 1;
      let row = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (displayLineStarts[mid] <= dOff) {
          row = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return { row, col: dOff - displayLineStarts[row] };
    },
    [displayLineStarts],
  );
  // Map a displayText offset to the equivalent offset in the full text.
  const displayToFull = useCallback(
    (dOff: number): number => {
      const { row, col } = displayRowCol(dOff);
      const absLine = visibleLineIndices[row] ?? lines.length - 1;
      return (lineStarts[absLine] ?? text.length) + col;
    },
    [displayRowCol, visibleLineIndices, lineStarts, lines.length, text.length],
  );
  // Commit an edited displayText: with no folds, straight through; with folds,
  // diff the single contiguous change (common prefix/suffix) and splice it into
  // the full text at the mapped offsets — folded content is preserved verbatim.
  const commit = useCallback(
    (nextDisplay: string) => {
      if (!buffer) return;
      if (!folded) {
        buffer.onChange(nextDisplay);
        return;
      }
      const old = displayText;
      const minLen = Math.min(old.length, nextDisplay.length);
      let p = 0;
      while (p < minLen && old.charCodeAt(p) === nextDisplay.charCodeAt(p)) p++;
      let sfx = 0;
      while (
        sfx < old.length - p &&
        sfx < nextDisplay.length - p &&
        old.charCodeAt(old.length - 1 - sfx) ===
          nextDisplay.charCodeAt(nextDisplay.length - 1 - sfx)
      )
        sfx++;
      const fp = displayToFull(p);
      const fe = displayToFull(old.length - sfx);
      buffer.onChange(
        text.slice(0, fp) +
          nextDisplay.slice(p, nextDisplay.length - sfx) +
          text.slice(fe),
      );
    },
    [buffer, folded, displayText, displayToFull, text],
  );

  // The caret overlay is a single full-height textarea holding the whole file,
  // so its lines must stay pixel-aligned with the rendered layer. Folding hides
  // lines from the rendered layer (which the textarea can't mirror), so we
  // suspend the overlay whenever anything is collapsed and fall back to the
  // read-only DOM-selection path; it returns once everything is expanded.
  // Line wrap turns rows into variable-height blocks the single `pre`/`wrap=off`
  // textarea can't mirror, so we suspend the overlay there too and let native
  // DOM selection take over.
  // A read-only file suspends the caret overlay under wrap or folding (the
  // wrap=off / flat textarea can't mirror wrapped or hidden rows) and falls back
  // to DOM selection. An editable buffer can't do that — you must be able to type
  // — so it KEEPS the overlay in both cases: it soft-wraps to the layer's width,
  // and when folded the overlay holds only the visible lines (`displayText`) with
  // edits mapped back into the full text, so folded content stays intact.
  const editorMode =
    ENABLE_EDITOR_CARET &&
    status === "ok" &&
    !isImage &&
    isTextContent &&
    lines.length <= EDITOR_MAX_LINES &&
    (liveCollapsed.size === 0 || !!buffer) &&
    (!lineWrapEnabled || !!buffer);

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
  // +3 reserves room on the right of the number for the fold chevron, so the
  // toggle sits clear of the line number rather than crowding it.
  const gutterChCount = gutterCh + 3; // matches the gutter span's `ch` width
  const gutterWidthPx = gutterChCount * charWidth;

  // Widest line in display columns. The caret textarea is sized from this so it
  // spans the full content width instead of clipping at the viewport edge — a
  // viewport-wide textarea desyncs from the (horizontally scrolling) highlighted
  // layer on long lines, which is what broke selecting overflowed text. Tabs are
  // over-counted to a tab stop so the textarea is never *narrower* than the text
  // (which would re-clip); only the editor overlay needs this, so skip the scan
  // for files too large for that mode.
  const maxLineCols = useMemo(() => {
    if (lines.length > EDITOR_MAX_LINES) return 0;
    let widest = 0;
    for (const ln of lines) {
      let cols = 0;
      for (let i = 0; i < ln.length; i++)
        cols += ln.charCodeAt(i) === 9 ? 8 : 1;
      if (cols > widest) widest = cols;
    }
    return widest;
  }, [lines]);
  // Full width of the code column (matches the line `<span>`'s pl-3 + text + pr-6).
  const editorContentWidth = CONTENT_PAD_LEFT + maxLineCols * charWidth + 24;

  /* ── Editor (textarea) selection state ────────────────────────── */

  // Live selection inside the editor textarea, in absolute char offsets. Drives
  // the visible highlight (the textarea's own selection is hidden via CSS).
  const [editorSel, setEditorSel] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [editorPopover, setEditorPopover] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // ⌘A in the virtualized read-only view. The DOM only holds the mounted rows,
  // so native select-all — and the copy that follows — would silently truncate
  // the file to the rendered window. Instead we own it: this flag paints a
  // whole-document highlight (per-row, so it survives scrolling) and ⌘C/copy
  // answer from the full in-memory `text`, never the DOM.
  const [selectAllActive, setSelectAllActive] = useState(false);

  useEffect(() => {
    // Reset selection, folds, and the symbol palette when the open file changes.
    setEditorSel(null);
    setEditorPopover(null);
    setSelectAllActive(false);
    setCollapsed(new Set());
    setSymbolOpen(false);
    setSymbols([]);
    setSymbolQuery("");
    setClickedLine(null);
    blameClose();
  }, [encoded, path, blameClose]);

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
          Math.min(x, window.innerWidth - POPOVER_VIEWPORT_PAD),
        ),
      };
    },
    [lineOfOffset, lineStarts, gutterWidthPx, charWidth],
  );

  const ensureCaretVisible = useCallback(
    (offset: number) => {
      const parent = parentRef.current;
      if (!parent) return;
      // The `offset` is in the textarea's own space — which for a buffer is
      // `displayText` (visible rows only). So the caret's VISUAL row is its
      // display row; for a file it's the (unfolded) full line.
      let row: number;
      let col: number;
      if (buffer) {
        ({ row, col } = displayRowCol(offset));
      } else {
        const ln = lineOfOffset(offset);
        row = ln;
        col = offset - lineStarts[ln];
      }
      const top = row * LINE_HEIGHT;
      const bottom = top + LINE_HEIGHT;
      if (top < parent.scrollTop) parent.scrollTop = top;
      else if (bottom > parent.scrollTop + parent.clientHeight)
        parent.scrollTop = bottom - parent.clientHeight;
      // Keep the caret horizontally in view too. The gutter is sticky over the
      // left edge, so the usable left boundary is gutterWidthPx, not 0.
      const caretX = gutterWidthPx + CONTENT_PAD_LEFT + col * charWidth;
      if (caretX < parent.scrollLeft + gutterWidthPx)
        parent.scrollLeft = caretX - gutterWidthPx;
      else if (caretX > parent.scrollLeft + parent.clientWidth)
        parent.scrollLeft = caretX - parent.clientWidth;
    },
    [buffer, displayRowCol, lineOfOffset, lineStarts, gutterWidthPx, charWidth],
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

  /* ── Inline blame (trailing annotation + hover card) ──────────── */

  // A blame is trusted only while its tag IS the rendered text (reference
  // equality in the steady state) — an in-flight fetch racing a disk change
  // fails the check by construction and renders nothing.
  const usableBlame = blame && blame.forText === text ? blame : null;

  // The annotated line: caret line in editor mode, last clicked line otherwise.
  const activeBlameLine = editorMode
    ? editorSel
      ? lineOfOffset(Math.max(editorSel.start, editorSel.end))
      : null
    : clickedLine;

  const blameChip = useMemo(() => {
    if (!usableBlame || activeBlameLine == null) return null;
    const info = blameLineInfo(usableBlame, activeBlameLine);
    if (!info) return null;
    const pos = posOfLine[activeBlameLine];
    if (pos < 0) return null; // folded away
    return { line: activeBlameLine, top: pos * LINE_HEIGHT, ...info };
  }, [usableBlame, activeBlameLine, posOfLine]);

  // Editor mode only: the caret textarea covers the rows, so the annotation
  // must be an absolutely-positioned sibling ABOVE it to stay hoverable. Its
  // x is measured from the row's content span (exact even for tabs and wide
  // glyphs); if the row is virtualized out of the DOM the chip would be
  // off-screen anyway, so it just hides. The read-only view has no overlay,
  // so there the chip renders inline in the row instead (which also handles
  // wrapped, variable-height rows).
  const [blameChipLeft, setBlameChipLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el =
      blameChip && editorMode
        ? parentRef.current?.querySelector<HTMLElement>(
            `[data-line-index="${blameChip.line}"] [data-line-content]`,
          )
        : null;
    // The span's width already includes its pl-3 and pr-6 (a built-in gap).
    setBlameChipLeft(
      el ? gutterWidthPx + el.getBoundingClientRect().width : null,
    );
  }, [blameChip, editorMode, gutterWidthPx]);

  // The card is fixed-position — close it when the code under it scrolls away
  // or the annotation moves to another line/commit.
  useEffect(() => {
    if (!hasBlameCard) return;
    const el = parentRef.current;
    el?.addEventListener("scroll", blameClose);
    window.addEventListener("resize", blameClose);
    return () => {
      el?.removeEventListener("scroll", blameClose);
      window.removeEventListener("resize", blameClose);
    };
  }, [hasBlameCard, blameClose]);
  const chipLine = blameChip?.line;
  const chipHash = blameChip?.commit?.hash;
  useEffect(() => {
    blameClose();
  }, [chipLine, chipHash, blameClose]);

  /* ── DOM selection (virtualized read-only fallback) ───────────── */

  // Map a selection endpoint back to the 0-based line index of its row.
  const lineIndexOf = useCallback((node: Node | null): number | null => {
    let el: Element | null =
      node instanceof Element ? node : (node?.parentElement ?? null);
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
      node instanceof Element ? node : (node?.parentElement ?? null);
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
    [lineIndexOf, contentElOf, lineStarts],
  );

  const createAnnotation = useCallback(
    (data: FileAnchor, selectedText: string, comment: string) => {
      onAddAnnotation(
        selectedText,
        data.startOffset,
        data.endOffset,
        data.startLine,
        data.endLine,
        comment,
      );
    },
    [onAddAnnotation],
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
      // Pushed first so it wins ties at the same start offset (findHl takes
      // the first match) — while everything is selected, the selection tint
      // sits on top of annotation/find tints, like an editor selection would.
      if (selectAllActive && le > ls) {
        out.push({ s: 0, e: le - ls, kind: "pending" });
      }
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
    [
      annotations,
      activeRange,
      revealRange,
      findByLine,
      lineStarts,
      lines,
      selectAllActive,
    ],
  );

  // Track the scroll viewport's height so `paddingEnd` below can equal it. The
  // deps re-run this once the scroll container actually mounts (it doesn't exist
  // while the file is still loading, or for image/binary views), otherwise the
  // one-shot mount effect would bail on a null ref and leave the height at 0.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    setViewportW(el.clientWidth);
    const ro = new ResizeObserver(() => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [status, isImage, data]);

  // Empty, line-number-free space under the last line so you can scroll it up to
  // the top of the viewport. It renders nothing (just extends the scroll extent),
  // so the file section's own background shows through — no separate surface.
  const scrollBeyondEnd = Math.max(0, viewportH - LINE_HEIGHT);

  // A small breathing margin above the first line — but only for the editable
  // buffer (the scratchpad), not files. `paddingStart` offsets every row, so the
  // overlay textarea is nudged down by the same amount (see its `top`).
  const bufferTopPad = buffer ? 8 : 0;

  const virtualizer = useVirtualizer({
    count: visibleLineIndices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
    paddingStart: bufferTopPad,
    paddingEnd: scrollBeyondEnd,
  });

  // Toggling wrap flips every row between a fixed 20px height and a measured,
  // variable height — drop the cached sizes so the next layout re-measures.
  useEffect(() => {
    virtualizer.measure();
  }, [lineWrapEnabled, virtualizer]);

  // Re-measure when the tab becomes visible again. While hidden (display:none)
  // the scroll element has 0 height and the virtualizer's range/sizes go stale;
  // without this the layer can render overlapping rows and the scroll extent is
  // wrong (the "combined text / can't scroll up" bug after switching tabs).
  useEffect(() => {
    if (active) virtualizer.measure();
  }, [active, virtualizer]);

  // Auto-focus the buffer editor when it first opens, caret at the end (last
  // line) so you can type immediately — line 1 when empty. Runs once; the
  // scratchpad wrapper only mounts this once its content has loaded.
  const didAutoFocus = useRef(false);
  useEffect(() => {
    if (!buffer || !active || !editorMode || didAutoFocus.current) return;
    didAutoFocus.current = true;
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus({ preventScroll: true });
      const end = t.value.length;
      t.setSelectionRange(end, end);
      ensureCaretVisible(end);
    });
  }, [buffer, active, editorMode, ensureCaretVisible]);

  // Sticky scope headers: the fold regions enclosing the topmost visible line
  // whose own start has already scrolled above the viewport. Outermost-first,
  // capped at STICKY_MAX. Driven by the virtualizer's own scroll offset (it
  // re-renders on scroll), so the pin tracks the rows with no separate listener
  // or lag. Reuses the very fold ranges the gutter chevrons use.
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const stickyHeaders = useMemo(() => {
    if (!stickyEnabled || foldRanges.length === 0) return [];
    // Derive the top visible row from the virtualizer (not scrollOffset /
    // LINE_HEIGHT) so it stays correct when line wrap makes rows variable-height.
    const topPos =
      virtualizer.getVirtualItemForOffset(scrollOffset)?.index ?? 0;
    // Build the stack slot by slot. Slot d sits at viewport y = d·LINE_HEIGHT,
    // i.e. over the line `topPos + d`. A scope fills slot d when it encloses that
    // line — so a deeper scope joins the moment its header reaches the BOTTOM of
    // the stack accumulated so far, not when it reaches the top of the viewport.
    const headers: number[] = [];
    for (let d = 0; d < STICKY_MAX; d++) {
      const refLine = visibleLineIndices[topPos + d];
      if (refLine == null) break;
      const chain = foldRanges
        .filter(
          (r) =>
            r.start <= refLine && r.end >= refLine && !hiddenLines.has(r.start),
        )
        .sort((a, b) => a.start - b.start);
      const next = chain[d];
      if (!next) break;
      // Strictly increasing nesting — stop if the chain shallowed out.
      if (headers.length && next.start <= headers[headers.length - 1]) break;
      headers.push(next.start);
    }
    return headers;
  }, [
    stickyEnabled,
    foldRanges,
    scrollOffset,
    visibleLineIndices,
    hiddenLines,
    virtualizer,
  ]);

  // Jump to + highlight a Search-tab hit. Re-runs on `nonce` so re-clicking the
  // same line scrolls again. Waits for the file to load before scrolling.
  const revealNonce = revealTarget?.nonce;
  useEffect(() => {
    if (!revealTarget || status !== "ok") return;
    const idx = Math.min(Math.max(revealTarget.line - 1, 0), lines.length - 1);
    const ls = lineStarts[idx] ?? 0;
    const caret = ls + revealTarget.colStart;
    setRevealRange({ s: caret, e: ls + revealTarget.colEnd });
    // Cmd-P "path:line" jump: leave a real, focused caret on the line so the
    // file opens ready for keyboard navigation, not just a passive highlight.
    // Only possible in editor mode (the caret lives in the overlay textarea;
    // huge files fall back to the read-only view and just get the highlight).
    // preventScroll because the textarea spans the whole file — a plain focus
    // would yank the view to its top; we centre the line via the virtualizer.
    if (revealTarget.focusCaret && editorMode) {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(caret, caret);
        setEditorSel({ start: caret, end: caret });
      }
    }
    // Unfold any region hiding the target, then scroll once it's back in view.
    revealLine(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, status]);

  // Run a queued reveal scroll once `visibleLineIndices` reflects the unfold, so
  // the target row exists in the virtualizer before we scroll to it.
  useEffect(() => {
    if (pendingScrollLine == null) return;
    const pos = posOfLine[pendingScrollLine];
    if (pos >= 0) {
      virtualizer.scrollToIndex(pos, { align: "center" });
      // Go-to-symbol asked for the caret on this line — place it now that the
      // line is unfolded and scrolled into view (editor mode only).
      if (caretRequestRef.current === pendingScrollLine) {
        caretRequestRef.current = null;
        const ta = textareaRef.current;
        if (ta) {
          const caret = lineStarts[pendingScrollLine] ?? 0;
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(caret, caret);
          setEditorSel({ start: caret, end: caret });
        }
      }
      setPendingScrollLine(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScrollLine, visibleLineIndices]);

  // ⌘F opens the find widget for the visible file, seeded with any selection.
  const searchable = status === "ok" && !isImage && isTextContent;
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
  }, [active, searchable, find]);

  // The editor overlay (a real textarea holding the whole file) owns ⌘A/⌘C
  // natively, so a lingering select-all flag from the read-only view must not
  // paint over it when the mode flips (e.g. wrap toggled off).
  useEffect(() => {
    if (editorMode) setSelectAllActive(false);
  }, [editorMode]);

  // ⌘A — select all, virtualized read-only view only (see `selectAllActive`).
  useEffect(() => {
    if (!active || !searchable || editorMode) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "a" &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        // Drop any native selection so the painted highlight is the only one.
        window.getSelection()?.removeAllRanges();
        setSelectAllActive(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, searchable, editorMode]);

  // While select-all is active: ⌘C (and any copy command) yields the complete
  // file text, Escape or a pointer-down dismisses it — the same lifecycle a
  // native selection would have.
  useEffect(() => {
    if (!selectAllActive || !active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "c" &&
        !isEditableTarget(e.target)
      ) {
        // No native selection exists (⌘A suppressed it), so without this the
        // keystroke would copy nothing.
        e.preventDefault();
        void navigator.clipboard.writeText(text);
      } else if (e.key === "Escape") {
        setSelectAllActive(false);
      }
    };
    // Context-menu "Copy" raises a copy event instead of going through ⌘C.
    const onCopy = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };
    const onMouseDown = () => setSelectAllActive(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("copy", onCopy);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [selectAllActive, active, text]);

  // ⌘⇧O — go to symbol. Only when the active engine can supply symbols (the
  // tree-sitter engine on desktop; the indentation fallback can't parse names).
  useEffect(() => {
    if (!active || !searchable || !foldEngine.computeSymbols) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        setSymbolQuery("");
        setSymbolOpen(true);
        void Promise.resolve(foldEngine.computeSymbols!(text, language)).then(
          (syms) => setSymbols(syms),
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, searchable, foldEngine, text, language]);

  // ⌥Z — toggle line wrap. Match `e.code` (not `e.key`): Option+letter emits a
  // special glyph on macOS ("Ω" for z), so the layout-independent physical code
  // is the only reliable signal.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        e.code === "KeyZ"
      ) {
        e.preventDefault();
        setLineWrap(!lineWrapEnabled);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, lineWrapEnabled]);

  const symbolFuse = useMemo(
    () =>
      new Fuse(symbols, {
        keys: ["name"],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [symbols],
  );
  const symbolItems = useMemo<PaletteItem[]>(() => {
    const list = symbolQuery
      ? symbolFuse.search(symbolQuery).map((r) => r.item)
      : symbols;
    return list.slice(0, 500).map((s, i) => ({
      id: `${s.line}:${s.kind}:${s.name}:${i}`,
      label: s.name,
      badge: s.kind,
      onSelect: () => {
        caretRequestRef.current = s.line;
        setSymbolOpen(false);
        revealLine(s.line);
      },
    }));
  }, [symbols, symbolQuery, symbolFuse, revealLine]);

  // Keep the active match scrolled into view as the user steps through.
  useEffect(() => {
    if (!find.open || find.current < 0) return;
    const m = find.matches[find.current];
    if (!m) return;
    revealLine(lineOfOffset(m.start));
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
    [selection],
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
        comment,
      );
      setEditorPopover(null);
      const ta = textareaRef.current;
      if (ta) ta.setSelectionRange(e, e);
      setEditorSel({ start: e, end: e });
    },
    [editorSel, text, onAddAnnotation, lineOfOffset],
  );

  /* ── Gutter cell (line number + comment marker) ──────────────── */

  function gutterCell(lineIdx: number) {
    const lineNo = lineIdx + 1;
    const anchored = firstOf.get(lineNo);
    const foldable = foldByStart.has(lineIdx);
    const isCollapsed = liveCollapsed.has(lineIdx);
    return (
      <span
        className={cn(
          "sticky left-0 z-10 flex shrink-0 select-none justify-end gap-1 bg-[var(--bg)] pr-5 pl-3 text-right text-[var(--text-tertiary)]",
          // When wrapping, a row can span several visual lines — pin the number
          // to the first one instead of centering it across the whole block.
          lineWrapEnabled ? "items-start" : "items-center",
        )}
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
        {/* Fold toggle: in the gutter's right padding, between number and code
            (never in the code, so it can't disturb the caret math). Always
            shown when collapsed; otherwise revealed on row hover. */}
        {foldable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFold(lineIdx);
            }}
            aria-label={isCollapsed ? "Expand region" : "Collapse region"}
            title={isCollapsed ? "Expand" : "Collapse"}
            className={cn(
              "absolute right-0 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-all duration-100 hover:scale-110 hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] hover:opacity-100 active:scale-90",
              // Always visible but subtle; brightens on hover / when collapsed.
              isCollapsed ? "opacity-100" : "opacity-60",
            )}
          >
            <FoldChevron collapsed={isCollapsed} />
          </button>
        )}
      </span>
    );
  }

  // Editor keystrokes for an in-memory buffer: format, smart indent, bracket
  // auto-pairing, and word / next-occurrence selection. Files never reach here
  // (buffer is undefined), so this leaves the read-only caret untouched.
  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!buffer) return;
    const ta = e.currentTarget;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const mod = e.metaKey || e.ctrlKey;
    // The textarea's offsets and value are in `displayText` space (= full text
    // unless folded, when it's the visible lines only). `commit` maps edits back
    // into the full text; `doc` is what the handler reasons over.
    const doc = displayText;
    const caretTo = (pos: number) =>
      requestAnimationFrame(() => ta.setSelectionRange(pos, pos));
    const replace = (from: number, to: number, ins: string, caret: number) => {
      commit(doc.slice(0, from) + ins + doc.slice(to));
      caretTo(caret);
    };

    // ⌘S → format.
    if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      buffer.onFormat?.();
      return;
    }

    // ⌘D → select the word under the caret; with a selection already, jump to
    // the next occurrence (wrapping). A textarea has ONE selection, so this is
    // select-word / find-next — it can't stack multiple cursors like VS Code.
    if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (s === en) {
        const isW = (c?: string) => !!c && /\w/.test(c);
        let a = s;
        let b = en;
        while (a > 0 && isW(doc[a - 1])) a--;
        while (b < doc.length && isW(doc[b])) b++;
        if (b > a) ta.setSelectionRange(a, b);
      } else {
        const sel = doc.slice(s, en);
        let idx = doc.indexOf(sel, en);
        if (idx < 0) idx = doc.indexOf(sel);
        if (idx >= 0) {
          ta.setSelectionRange(idx, idx + sel.length);
          requestAnimationFrame(() => ensureCaretVisible(idx + sel.length));
        }
      }
      return;
    }

    // Leave every other modifier combo (undo/copy/paste/select-all/…) to the OS.
    if (mod) return;

    const before = doc.slice(0, s);
    const after = doc.slice(en);
    const prev = before.slice(-1);
    const next = after.slice(0, 1);

    // Tab → two spaces.
    if (e.key === "Tab") {
      e.preventDefault();
      replace(s, en, "  ", s + 2);
      return;
    }

    // Enter → carry the current line's indent; between an open/close pair, open
    // a blank indented line with the closer dropped onto the line below.
    if (e.key === "Enter") {
      const lineStart = before.lastIndexOf("\n") + 1;
      const indent = (before.slice(lineStart).match(/^[ \t]*/) ?? [""])[0];
      const pair =
        (prev === "{" && next === "}") ||
        (prev === "[" && next === "]") ||
        (prev === "(" && next === ")");
      e.preventDefault();
      if (pair && s === en) {
        const inner = indent + "  ";
        replace(s, en, "\n" + inner + "\n" + indent, s + 1 + inner.length);
      } else {
        const extra = /[{[(]$/.test(before) ? "  " : "";
        replace(
          s,
          en,
          "\n" + indent + extra,
          s + 1 + indent.length + extra.length,
        );
      }
      return;
    }

    const OPEN: Record<string, string> = {
      "{": "}",
      "[": "]",
      "(": ")",
      '"': '"',
      "'": "'",
      "`": "`",
    };

    // With a selection: wrap it in the pair (surround, don't replace) and keep
    // the same text selected inside — e.g. select `foo`, press " → `"foo"`.
    if (s !== en && OPEN[e.key]) {
      e.preventDefault();
      const sel = doc.slice(s, en);
      commit(doc.slice(0, s) + e.key + sel + OPEN[e.key] + doc.slice(en));
      requestAnimationFrame(() => ta.setSelectionRange(s + 1, en + 1));
      return;
    }

    // Auto-close brackets / quotes (collapsed caret only).
    if (s === en && OPEN[e.key]) {
      const quote = e.key === '"' || e.key === "'" || e.key === "`";
      // Skip quote-pairing next to a word char (likely an apostrophe / closer).
      if (!(quote && (/\w/.test(prev) || next === e.key))) {
        e.preventDefault();
        replace(s, en, e.key + OPEN[e.key], s + 1);
        return;
      }
    }

    // Type over an auto-inserted closer instead of doubling it.
    if (s === en && next === e.key && ")]}\"'`".includes(e.key)) {
      e.preventDefault();
      caretTo(s + 1);
      return;
    }

    // Backspace between an empty pair deletes both halves.
    if (e.key === "Backspace" && s === en && next && OPEN[prev] === next) {
      e.preventDefault();
      replace(s - 1, en + 1, "", s - 1);
      return;
    }
  };

  const newCommentPopover = buffer
    ? // Scratch buffers have no comment system — never offer the popover.
      null
    : editorMode
      ? editorPopover && editorSel && editorSel.start !== editorSel.end
        ? {
            position: editorPopover,
            selectedText: text.slice(
              Math.min(editorSel.start, editorSel.end),
              Math.max(editorSel.start, editorSel.end),
            ),
            onSubmit: submitEditorComment,
            onClose: () => {
              setEditorPopover(null);
              const ta = textareaRef.current;
              if (ta && editorSel)
                ta.setSelectionRange(editorSel.end, editorSel.end);
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
        {buffer ? (
          <>
            <NotebookPen
              size={13}
              className="shrink-0 text-[var(--text-tertiary)]"
            />
            <span className="text-[var(--text)]">{buffer.title}</span>
          </>
        ) : (
          <>
            <FileIcon name={basename(path)} />
            <span className="truncate text-[var(--text)]">
              {basename(path)}
            </span>
            <span className="truncate text-[var(--text-tertiary)]">{path}</span>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {data?.truncated && (
            <span className="text-[var(--text-tertiary)]">truncated</span>
          )}
          {buffer && (
            <>
              <select
                value={buffer.language}
                onChange={(e) => buffer.onLanguageChange(e.target.value)}
                title="Language (used for Format)"
                className="h-7 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
              >
                {buffer.languages.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              {buffer.onFormat && (
                <button
                  onClick={buffer.onFormat}
                  disabled={!buffer.canFormat}
                  title={
                    buffer.canFormat
                      ? "Format (⌘S)"
                      : "No formatter for this language"
                  }
                  className="flex h-7 items-center rounded-md border border-[var(--border)] px-2 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-tertiary)]"
                >
                  Format
                </button>
              )}
            </>
          )}
          {!buffer && !isImage && text.length > 0 && (
            <button
              onClick={() =>
                window.open(
                  buildDocUrl({ text, language, comments: [] }),
                  "_blank",
                  "noopener",
                )
              }
              title="Open this file as a shareable doc others can comment on"
              className="flex h-7 items-center rounded-md border border-[var(--border)] px-2 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
            >
              Share for comments
            </button>
          )}
          <div className="relative" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen((o) => !o)}
              title="View settings"
              aria-label="View settings"
              aria-expanded={settingsOpen}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md border text-[14px] transition-colors",
                settingsOpen
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
              )}
            >
              ⚙
            </button>
            {settingsOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 flex w-max flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5 shadow-lg">
                {(
                  [
                    {
                      label: "Line wrap",
                      on: lineWrapEnabled,
                      set: setLineWrap,
                    },
                    {
                      label: "Sticky scroll",
                      on: stickyEnabled,
                      set: stickyScrollSetting.set,
                    },
                    {
                      label: "Bracket colors",
                      on: bracketEnabled,
                      set: bracketColorSetting.set,
                    },
                    // A scratch buffer has no git history to annotate.
                    ...(buffer
                      ? []
                      : [
                          {
                            label: "Inline blame",
                            on: blameEnabled,
                            set: inlineBlameSetting.set,
                          },
                        ]),
                  ] as {
                    label: string;
                    on: boolean;
                    set: (on: boolean) => void;
                  }[]
                ).map(({ label, on, set }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                      {label}
                    </span>
                    <button
                      onClick={() => set(!on)}
                      aria-pressed={on}
                      className={cn(
                        "rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors",
                        on
                          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)]",
                      )}
                    >
                      {on ? "On" : "Off"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
                // Wrapping keeps text inside the viewport width; otherwise the
                // content grows as wide as its longest line for horizontal scroll.
                width: lineWrapEnabled ? "100%" : "max-content",
                minWidth: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const lineIdx = visibleLineIndices[vi.index];
                const line = lines[lineIdx];
                const isCollapsed = liveCollapsed.has(lineIdx);
                return (
                  <div
                    key={vi.key}
                    data-line-index={lineIdx}
                    data-index={vi.index}
                    // In wrap mode the row's height is whatever the wrapped text
                    // measures to, so hand it to the virtualizer to size; otherwise
                    // every row is a fixed 20px and needs no measurement.
                    ref={
                      lineWrapEnabled ? virtualizer.measureElement : undefined
                    }
                    className={cn(
                      "group absolute left-0 top-0 flex w-full",
                      lineWrapEnabled && "items-start",
                    )}
                    style={{
                      height: lineWrapEnabled ? undefined : LINE_HEIGHT,
                      transform: `translateY(${vi.start}px)`,
                    }}
                    // No caret in the read-only fallback — a click marks the
                    // line as active for the inline blame annotation instead.
                    onClick={
                      editorMode ? undefined : () => setClickedLine(lineIdx)
                    }
                  >
                    {gutterCell(lineIdx)}
                    <span
                      data-line-content
                      className={cn(
                        "pl-3 pr-6 text-[var(--text)]",
                        // Wrapping needs the span to shrink within the flex row
                        // (min-w-0) and break long lines; otherwise it stays on one
                        // pre-formatted line and the row scrolls horizontally.
                        lineWrapEnabled
                          ? "min-w-0 flex-1 whitespace-pre-wrap break-words"
                          : "whitespace-pre",
                        // In editor mode the textarea owns selection; elsewhere the
                        // content opts into native text selection.
                        !editorMode && "select-text [cursor:text]",
                      )}
                    >
                      {selectAllActive && !line.length ? (
                        // A blank line has no characters for the range-based
                        // tint to land on — a single tinted space keeps the
                        // select-all highlight from visually skipping it.
                        <span
                          className="rounded-sm"
                          style={{ background: "var(--selection-bg)" }}
                        >
                          {" "}
                        </span>
                      ) : (
                        lineNodes(
                          line,
                          perLine[lineIdx],
                          hlsForLine(lineIdx),
                          bracketByLine.get(lineIdx),
                        )
                      )}
                      {/* A collapsed region shows a "⋯" affordance on its header
                        line; clicking it (or the gutter chevron) re-expands. */}
                      {isCollapsed && (
                        <span
                          onClick={() => toggleFold(lineIdx)}
                          className="ml-1 cursor-pointer select-none rounded-sm bg-[var(--bg-surface-hover)] px-1 text-[var(--text-tertiary)]"
                          title="Expand"
                        >
                          ⋯
                        </span>
                      )}
                      {/* Read-only view: no textarea covers the rows, so the
                          blame annotation anchors at the end of the text.
                          `absolute` with auto offsets = the browser's static
                          position (exactly where the text ends, even mid-wrap)
                          while taking ZERO layout space — in-flow versions
                          reflowed the code (a flex sibling squeezed it to a
                          1-char column; an inline span forced earlier wraps).
                          It must not add a text node either — the label lives
                          in the .blame-chip ::after pseudo, so selection
                          offsets and copying are untouched. (Editor mode uses
                          the overlay below.) */}
                      {!editorMode && blameChip?.line === lineIdx && (
                        <span
                          data-blame-label={blameChip.label}
                          className="blame-chip"
                          onMouseEnter={(e) =>
                            blameChipEnter(
                              e.currentTarget.getBoundingClientRect(),
                              blameChip,
                            )
                          }
                          onMouseLeave={blameChipLeave}
                          onClick={(e) => {
                            e.stopPropagation();
                            blameOpen(
                              e.currentTarget.getBoundingClientRect(),
                              blameChip,
                            );
                          }}
                        />
                      )}
                    </span>
                  </div>
                );
              })}
              {editorMode && (
                <textarea
                  ref={textareaRef}
                  className="file-editor-input absolute bottom-0 resize-none border-0 bg-transparent p-0 text-[13px] leading-[20px] outline-none"
                  // A full-height overlay must never scroll ITSELF — the parent is
                  // the only scroller. If the browser nudges it (caret follow on a
                  // stale layout), its text slides out from under the highlighted
                  // layer (the "combined text" overlap). Pin it back to 0.
                  onScroll={(e) => {
                    if (e.currentTarget.scrollTop !== 0)
                      e.currentTarget.scrollTop = 0;
                    if (e.currentTarget.scrollLeft !== 0)
                      e.currentTarget.scrollLeft = 0;
                  }}
                  style={{
                    top: bufferTopPad,
                    left: gutterWidthPx,
                    // No-wrap: span the full content width (not the viewport) so the
                    // textarea scrolls in lockstep with the highlighted layer —
                    // pinning to right:0 would clip it and desync selection on long
                    // lines. Wrap (buffer only): pin to right:0 and match the layer's
                    // pl-3/pr-6 padding so it soft-wraps at the exact same column,
                    // keeping the caret aligned with the wrapped rows.
                    ...(lineWrapEnabled
                      ? {
                          right: 0,
                          paddingLeft: CONTENT_PAD_LEFT,
                          paddingRight: 24,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "break-word",
                        }
                      : {
                          // At least fill the viewport (minus the gutter) so a
                          // click in the empty space past a short line still hits
                          // the textarea and drops a caret on that line; grow
                          // wider than the viewport for long lines (h-scroll).
                          width: Math.max(
                            editorContentWidth,
                            viewportW - gutterWidthPx,
                          ),
                          paddingLeft: CONTENT_PAD_LEFT,
                          whiteSpace: "pre",
                        }),
                    fontFamily: "var(--font-mono)",
                    color: "transparent",
                    caretColor: "var(--text)",
                    overflow: "hidden",
                  }}
                  // `displayText` is the full text unless folded, when it's just
                  // the visible lines; `commit` maps edits back to the full text.
                  value={displayText}
                  wrap={lineWrapEnabled ? "soft" : "off"}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label={
                    buffer ? buffer.title : `${basename(path)} contents`
                  }
                  // Editable (so the caret shows — readOnly hides it). For a file
                  // with no in-memory buffer, `allowTyping` is false and every
                  // mutation is cancelled below (read-only caret + selection only).
                  onChange={(e) => {
                    if (buffer) commit(e.target.value);
                  }}
                  onKeyDown={onEditorKeyDown}
                  onBeforeInput={(e) => {
                    if (!allowTyping) e.preventDefault();
                  }}
                  onPaste={(e) => {
                    if (!allowTyping) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    if (!allowTyping) e.preventDefault();
                  }}
                  // No onSelect: the native selection renders live on its own.
                  // Reading it into React state per drag-tick is what made the old
                  // selection lag — so we only settle it on release / key-up.
                  onMouseUp={() => {
                    const s = readEditorSel();
                    if (!s) return;
                    if (s.start !== s.end)
                      setEditorPopover(
                        caretPopoverPos(Math.max(s.start, s.end)),
                      );
                    else setEditorPopover(null);
                  }}
                  onKeyUp={(e) => {
                    const s = readEditorSel();
                    if (!s) return;
                    ensureCaretVisible(s.end);
                    if (e.shiftKey && s.start !== s.end)
                      setEditorPopover(
                        caretPopoverPos(Math.max(s.start, s.end)),
                      );
                    else if (s.start === s.end) setEditorPopover(null);
                  }}
                />
              )}
              {/* Inline blame, editor mode: muted authorship after the caret
                  line's text. Rendered AFTER the textarea so it paints (and
                  hovers) above the caret overlay; the layer's mono font/size
                  is inherited, so it sits pixel-aligned with the code row. */}
              {editorMode && blameChip && blameChipLeft != null && (
                <div
                  className="absolute z-10 flex select-none items-center whitespace-pre text-[var(--text-tertiary)] opacity-60 transition-opacity hover:opacity-100"
                  style={{
                    top: blameChip.top,
                    left: blameChipLeft,
                    height: LINE_HEIGHT,
                  }}
                  onMouseEnter={(e) =>
                    blameChipEnter(
                      e.currentTarget.getBoundingClientRect(),
                      blameChip,
                    )
                  }
                  onMouseLeave={blameChipLeave}
                  onClick={(e) =>
                    blameOpen(
                      e.currentTarget.getBoundingClientRect(),
                      blameChip,
                    )
                  }
                >
                  {blameChip.label}
                </div>
              )}
            </div>
          </div>
          {/* Sticky scroll: enclosing scope headers pinned at the top, each a
              click-to-jump target. Overlays the scroll viewport (z above it). */}
          {stickyHeaders.length > 0 && (
            // Must mirror the scroll layer's typography exactly (it's a sibling,
            // so it inherits nothing): same mono font, 13px, 20px line height.
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-[var(--bg)] font-[family-name:var(--font-mono)] text-[13px] leading-[20px] shadow-[0_1px_0_var(--border),0_4px_8px_-4px_rgba(0,0,0,0.25)]">
              {stickyHeaders.map((startIdx) => (
                <div
                  key={startIdx}
                  onClick={() => {
                    const pos = posOfLine[startIdx];
                    if (pos >= 0)
                      virtualizer.scrollToIndex(pos, { align: "start" });
                  }}
                  title="Jump to this line"
                  className="pointer-events-auto flex w-full cursor-pointer items-center hover:bg-[var(--bg-surface-hover)]"
                  style={{ height: LINE_HEIGHT }}
                >
                  <span
                    className="flex shrink-0 select-none items-center justify-end pr-5 pl-3 text-right text-[var(--text-tertiary)]"
                    style={{ width: gutterWidthPx }}
                  >
                    {startIdx + 1}
                  </span>
                  <span className="whitespace-pre pl-3 pr-6 text-[var(--text)]">
                    {lineNodes(
                      lines[startIdx],
                      perLine[startIdx],
                      [],
                      bracketByLine.get(startIdx),
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
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
      {blameCard}
      {lightbox && imageUrl && (
        <ImageLightbox src={imageUrl} onClose={() => setLightbox(false)} />
      )}
      <CommandPalette
        open={symbolOpen}
        placeholder="Go to symbol…"
        query={symbolQuery}
        onQueryChange={setSymbolQuery}
        items={symbolItems}
        onClose={() => setSymbolOpen(false)}
        emptyLabel="No symbols"
      />
    </div>
  );
}

/** Sum text length within a content span up to (node, nodeOffset). */
function offsetWithinContent(
  contentEl: Element,
  node: Node,
  nodeOffset: number,
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
