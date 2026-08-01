"use client";

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { excerpt, type Excerpt } from "../lib/comments/excerpt";
import type { AnnotationContext } from "../lib/comments/store";

const POPOVER_WIDTH = 360;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const CLICK_OUTSIDE_DELAY_MS = 100;

/** Input sizing, in px. The floor is two rows so the box never opens as a
 *  single line, the ceiling is eight before it scrolls internally. */
const INPUT_LINE_HEIGHT = 21;
const INPUT_MIN_HEIGHT = INPUT_LINE_HEIGHT * 2;
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * 8;

/** Mirrors the budget `formatAnnotation` applies, so the preview shows exactly
 *  the text that will be sent. */
const ANCHORED_EXCERPT_BUDGET = 700;
const UNANCHORED_EXCERPT_BUDGET = 1400;

interface CommentPopoverProps {
  position: { top: number; left: number; anchorTop?: number };
  selectedText: string;
  /** Location of the selection, when the surface has one. Rendered as the
   *  header line and, at send time, as the message's location prefix — so a
   *  missing header means the outgoing comment has no anchor either. */
  context?: AnnotationContext;
  initialComment?: string;
  submitLabel?: string;
  onSubmit: (comment: string) => void;
  onClose: () => void;
  onDelete?: () => void;
}

/** Long enough that crossing the footer on the way to the send button doesn't
 *  flash the peek open. */
const PEEK_DELAY_MS = 160;
const PEEK_MAX_HEIGHT = 156;

/** The pieces stay separate so only the path elides, and so the separators
 *  can't be reordered by the path's rtl truncation. */
interface SourceParts {
  /** `+` / `−` on a diff, otherwise the surface's own glyph. */
  glyph: "file" | "add" | "remove" | "pr" | "chat";
  /** Tint for the glyph. Neutral unless the side is known. */
  tone: "neutral" | "new" | "old";
  /** Pinned to the leading edge — never truncated. */
  lead: string | null;
  /** The only part that elides. */
  path: string | null;
  lines: string | null;
}

function sourceParts(ctx?: AnnotationContext): SourceParts | null {
  if (!ctx) return null;
  const { filePath, startLine, endLine, kind, side, pr, turn, role } = ctx;

  const lines =
    startLine != null
      ? endLine != null && endLine !== startLine
        ? `${startLine}–${endLine}`
        : `${startLine}`
      : null;

  if (kind === "chat") {
    const who = role === "user" ? "You" : "Claude";
    return {
      glyph: "chat",
      tone: "neutral",
      lead: null,
      path: turn != null ? `${who} · turn ${turn}` : who,
      lines: null,
    };
  }

  if (kind === "diff") {
    return {
      glyph: side === "left" ? "remove" : "add",
      tone: side === "left" ? "old" : "new",
      lead: null,
      path: filePath ?? null,
      lines,
    };
  }

  if (kind === "pr" || pr != null) {
    return {
      glyph: "pr",
      tone: "neutral",
      lead: pr != null ? `#${pr}` : null,
      path: filePath ?? null,
      lines,
    };
  }

  if (!filePath && !lines) return null;
  return {
    glyph: "file",
    tone: "neutral",
    lead: null,
    path: filePath ?? null,
    lines,
  };
}

function SourceGlyph({
  glyph,
  size,
}: {
  glyph: SourceParts["glyph"];
  size: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    // An SVG in a flex row is shrinkable by default; without this the glyph
    // squashes before the path starts truncating.
    className: "shrink-0",
    "aria-hidden": true,
  };
  if (glyph === "add")
    return (
      <svg {...common} strokeWidth="2.1">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  if (glyph === "remove")
    return (
      <svg {...common} strokeWidth="2.1">
        <path d="M5 12h14" />
      </svg>
    );
  if (glyph === "pr")
    return (
      <svg {...common} strokeWidth="1.9">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <path d="M6 9v12" />
      </svg>
    );
  if (glyph === "chat")
    return (
      <svg {...common} strokeWidth="1.9">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 3.6 11 8.4 8.4 0 0 1 12 2.6a8.4 8.4 0 0 1 9 8.4Z" />
      </svg>
    );
  return (
    <svg {...common} strokeWidth="1.9">
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
    </svg>
  );
}

const TONE_CLASS: Record<SourceParts["tone"], string> = {
  neutral: "text-[var(--text-tertiary)]",
  new: "text-[var(--added-text)]",
  old: "text-[var(--removed-text)]",
};

/**
 * The source of the selection, as a pill in the popover's footer. Hovering it
 * reveals the exact text the outgoing message will carry — the same
 * `excerpt()` string `formatAnnotation` emits, elision marker included.
 *
 * It is a button only so it can take focus and reach keyboard users; there is
 * nothing to click and nothing to remove.
 */
function SourcePill({
  source,
  preview,
}: {
  source: SourceParts;
  preview: Excerpt;
}) {
  const [open, setOpen] = useState(false);
  // The peek opens above the pill, but the card itself may already have flipped
  // above the selection — near the top of the window there's no room, so drop
  // it below rather than let it run off screen.
  const [below, setBelow] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  function show() {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = wrapRef.current?.getBoundingClientRect();
      setBelow(rect != null && rect.top < PEEK_MAX_HEIGHT + 24);
      setOpen(true);
    }, PEEK_DELAY_MS);
  }
  function hide() {
    if (timer.current != null) window.clearTimeout(timer.current);
    setOpen(false);
  }

  const label = [source.lead, source.path, source.lines]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      ref={wrapRef}
      className="relative flex min-w-0"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <button
        type="button"
        aria-label={`Source: ${label}`}
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        className={`flex h-[22px] w-full min-w-0 cursor-default items-center gap-1.5 rounded-md bg-[var(--highlight-bg)] px-2 font-[family-name:var(--font-mono)] text-[10.5px] tabular-nums transition-colors duration-100 hover:bg-[var(--bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${TONE_CLASS[source.tone]}`}
      >
        <SourceGlyph glyph={source.glyph} size={12} />
        {source.lead && (
          <span className="shrink-0 text-[var(--text-tertiary)]">
            {source.lead}
          </span>
        )}
        {source.path && (
          <>
            {source.lead && <Sep />}
            {/* Elide from the left — the filename identifies it, the leading
                directories don't. <bdi> keeps the path itself in logical order
                inside the rtl box. */}
            <span
              className="truncate text-left text-[var(--text-tertiary)]"
              style={{ direction: "rtl" }}
            >
              <bdi>{source.path}</bdi>
            </span>
          </>
        )}
        {source.lines && (
          <>
            {(source.lead || source.path) && <Sep />}
            <span className="shrink-0 text-[var(--text-tertiary)]">
              {source.lines}
            </span>
          </>
        )}
      </button>

      {open && (
        <span
          role="tooltip"
          className={`absolute left-0 z-20 flex w-[340px] max-w-[80vw] flex-col overflow-hidden rounded-[10px] bg-[var(--popover-bg)] ${below ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"}`}
          style={{
            boxShadow:
              "0 0 0 0.5px var(--popover-border), 0 2px 4px rgb(0 0 0 / 0.18), 0 14px 34px -10px rgb(0 0 0 / 0.34)",
          }}
        >
          <span className="flex min-w-0 items-center gap-1.5 border-b border-[var(--border)] px-[11px] py-[7px] font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            <span className={`flex shrink-0 ${TONE_CLASS[source.tone]}`}>
              <SourceGlyph glyph={source.glyph} size={11} />
            </span>
            {source.lead && <span className="shrink-0">{source.lead}</span>}
            {source.lead && source.path && <Sep />}
            {source.path && (
              <span className="truncate text-left" style={{ direction: "rtl" }}>
                <bdi>{source.path}</bdi>
              </span>
            )}
            {source.lines && (
              <span className="ml-auto shrink-0 opacity-80">
                L{source.lines}
              </span>
            )}
          </span>
          <pre
            className="scrollbar-minimal m-0 select-text overflow-y-auto whitespace-pre-wrap break-words px-[11px] py-2.5 font-[family-name:var(--font-mono)] text-[10.5px] leading-[1.62] text-[var(--text-secondary)]"
            style={{ maxHeight: PEEK_MAX_HEIGHT }}
          >
            {preview.text}
          </pre>
        </span>
      )}
      {/* Bridges the gap between pill and peek so the pointer can travel into
          it without the mouseleave firing first. */}
      {open && (
        <span
          aria-hidden="true"
          className={`absolute left-0 right-0 h-2.5 ${below ? "top-full" : "bottom-full"}`}
        />
      )}
    </span>
  );
}

function Sep() {
  return <span className="shrink-0 opacity-40">·</span>;
}

export function CommentPopover({
  position,
  selectedText,
  context,
  initialComment = "",
  submitLabel = "Comment",
  onSubmit,
  onClose,
  onDelete,
}: CommentPopoverProps) {
  const [comment, setComment] = useState(initialComment);
  const [height, setHeight] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const source = sourceParts(context);
  const anchored = source != null;
  const preview = useMemo(
    () =>
      excerpt(
        selectedText,
        anchored ? ANCHORED_EXCERPT_BUDGET : UNANCHORED_EXCERPT_BUDGET,
      ),
    [selectedText, anchored],
  );

  // Focus only once the card has been measured and is no longer hidden. A
  // `visibility: hidden` element is not focusable, so focusing during the
  // pre-measure pass silently did nothing and left you clicking into the box.
  const focusedRef = useRef(false);
  useLayoutEffect(() => {
    if (focusedRef.current || height == null) return;
    const el = textareaRef.current;
    if (!el) return;
    focusedRef.current = true;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [height]);

  // Both of these run after EVERY render, deliberately. Keying them to
  // `comment` missed any resize that didn't come from a keystroke — a paste
  // landed in a box still one row tall, scrolled to the caret, with the rest of
  // the text hidden above the fold.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT)}px`;
  });

  // Flipping needs the rendered height. Bailing when it hasn't moved keeps this
  // to one extra layout pass instead of a render loop.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const measured = el.offsetHeight;
    setHeight((prev) => (prev === measured ? prev : measured));
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Auto-focusing the textarea collapses the document selection the user
      // made, so a plain cmd/ctrl+C would copy the empty textarea instead of
      // the highlighted text. When the textarea has no selection of its own,
      // honour the gesture by copying the originally-selected text. If the user
      // has selected text inside the textarea, let the native copy through.
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const el = textareaRef.current;
        const hasOwnSelection =
          el != null && el.selectionStart !== el.selectionEnd;
        if (!hasOwnSelection && selectedText) {
          e.preventDefault();
          void navigator.clipboard.writeText(selectedText);
        }
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, CLICK_OUTSIDE_DELAY_MS);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, selectedText]);

  function handleSubmit() {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Stop the keystroke from also reaching the comments panel's window-level
      // ⌘↵ listener (it's armed whenever the chat composer is blurred). Without
      // this, submitting a comment would in the same stroke flush the whole
      // buffer to chat — the comment should settle in the panel first.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      handleSubmit();
    }
  }

  // Flip above the selection when there's no room below, rather than clamping
  // the card upward onto the text being commented on.
  let top = position.top;
  let flip = false;
  if (
    height != null &&
    position.top + height > window.innerHeight - VIEWPORT_MARGIN
  ) {
    flip = true;
    const anchorTop = position.anchorTop ?? position.top;
    top = Math.max(VIEWPORT_MARGIN, anchorTop - height - ANCHOR_GAP);
  }
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      position.left,
      window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN,
    ),
  );

  const dirty = comment.trim().length > 0;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={onDelete ? "Edit comment" : "Add comment"}
      className="comment-popover-in fixed z-50 rounded-xl"
      style={{
        top,
        left,
        width: POPOVER_WIDTH,
        visibility: height == null ? "hidden" : undefined,
        transformOrigin: flip ? "bottom left" : "top left",
        // Opaque. The translucent version read as mud over a dense transcript —
        // the text underneath showed through the card it was supposed to sit on.
        background: "var(--popover-bg)",
        boxShadow:
          "0 0 0 0.5px var(--popover-border), 0 2px 4px rgb(0 0 0 / 0.18), 0 14px 34px -10px rgb(0 0 0 / 0.34)",
      }}
    >
      <div className="flex flex-col gap-2 p-3">
        <textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment"
          aria-label="Comment"
          rows={2}
          className="scrollbar-minimal block w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
          style={{
            lineHeight: `${INPUT_LINE_HEIGHT}px`,
            minHeight: INPUT_MIN_HEIGHT,
            maxHeight: INPUT_MAX_HEIGHT,
          }}
        />

        {/* Always mounted. Revealing it on the first keystroke moved everything
            below it by a row mid-typing. */}
        <div className="mt-1 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            {source && <SourcePill source={source} preview={preview} />}
            {onDelete && (
              <button
                onClick={onDelete}
                aria-label="Delete comment"
                title="Delete comment"
                className="relative grid size-7 shrink-0 place-items-center rounded-full text-[var(--removed-text)] opacity-85 transition-[opacity,background-color,transform] duration-100 after:absolute after:-inset-1 after:content-[''] hover:bg-[color-mix(in_srgb,var(--removed-text)_14%,transparent)] hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current active:scale-[0.96]"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
          {/* aria-disabled rather than disabled: it's the only control in the
              footer, so a keyboard user tabbing here needs to find it and hear
              why it won't fire. The handler already ignores an empty comment. */}
          <button
            onClick={handleSubmit}
            aria-disabled={!dirty}
            aria-label={`${submitLabel} (⌘↵)`}
            title={`${submitLabel} — ⌘↵`}
            className={`relative grid size-7 shrink-0 place-items-center rounded-full transition-[background-color,transform] duration-100 after:absolute after:-inset-1.5 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
              dirty
                ? "bg-[var(--accent)] text-[var(--bg)] hover:bg-[var(--accent-hover)] active:scale-[0.96]"
                : "cursor-default bg-[var(--border-strong)] text-[var(--text-tertiary)]"
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
