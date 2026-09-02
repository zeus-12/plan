import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, Wrench } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import { basename } from "@plan/shared/lib/path";
import { useCommentSelection } from "@plan/shared/lib/comments/use-comment-selection";
import { useTextFind } from "@plan/shared/lib/text/use-text-find";
import {
  ancestorWithAttr,
  collectTextSegments,
  lastLineRect,
  offsetWithin,
  rangeForOffsets,
  rangeFromSegments,
  selectedOffsetsWithin,
  textOf,
  type TextSegment,
} from "@plan/shared/lib/text/dom-text";
import { CommentPopover } from "@plan/shared/components/comment-popover";

import { FindWidget } from "@plan/shared/components/find-widget";
import { Markdown } from "@plan/shared/components/markdown";
import {
  chatScrollKey,
  getChatScroll,
  setChatScroll,
  type ChatScrollPos,
} from "./chat-scroll-store";
import {
  abortedPromptUuids,
  classifyMessage,
  imageOnlyPaths,
  interruptionKind,
  isImageOnlyMessage,
  isRealUserTurn,
  parseBashBlock,
  parseLocalCommandOutput,
  parseTaskNotifications,
  type MessageCategory,
  type TaskNotification,
} from "./message-kind";
import { InterruptedRow } from "./interrupted-row";
import { AskQuestionCard, parseAskInput } from "./ask-question-card";
import {
  PlanCard,
  isPlanFilePath,
  parsePlanInput,
  type PlanVersionInfo,
} from "./plan-card";
import { useRowWindow } from "./row-window";
import { findToolRuns, type ToolRun } from "./tool-runs";
import { TurnFilesStrip, turnFileChangesByRow } from "./turn-files";
import { parseSendUserFile } from "./sent-file";
import { SentFileBlock } from "./sent-file-row";
import {
  ToolPreviewCard,
  hasImageResult,
  readResultPreview,
  resultImagePreview,
  toolPreview,
  useToolPreviewHover,
} from "./tool-preview-card";
import { SessionCwdContext } from "./session-cwd";
import { ImageLightbox } from "@/renderer/components/image-lightbox";
import { MessageRail } from "./message-rail";
import { TimeAgo } from "@/renderer/components/time-ago";
import type { ConversationMessage, MessagePart } from "@/common/shared-types";
import type { AnnotationContext } from "@plan/shared/lib/comments/store";
import type {
  ChatAnchor,
  ChatAnnotation,
  ChatSpan,
} from "@/renderer/features/comments/annotation-store";
import { Chevron } from "@/renderer/components/chevron";

/**
 * A chat comment's source, for the popover's pill and for the location line in
 * the outgoing message. Chat selections have no file or line to point at, so
 * the turn is the only anchor Claude gets besides the excerpt itself.
 */
function chatContext(
  messages: ConversationMessage[],
  messageUuid: string,
): AnnotationContext | undefined {
  const idx = messages.findIndex((m) => m.uuid === messageUuid);
  if (idx === -1) return { kind: "chat" };
  return { kind: "chat", turn: idx + 1, role: messages[idx].role };
}

/** How far (px) above the bottom the user must scroll before the "jump to
 *  latest" button appears. */
const SCROLL_DOWN_THRESHOLD_PX = 400;

/** Within this of the bottom counts as "following the newest message". */
const BOTTOM_EPSILON_PX = 20;

/** How long a restore keeps re-applying its target while the transcript's
 *  heights settle (async markdown/shiki/images, content-visibility). */
const RESTORE_SETTLE_MS = 900;

/** Idle time after scrolling before the anchor row is re-sampled. */
const ANCHOR_SAMPLE_MS = 120;

/**
 * The message row under the pane's top edge, and how far below that edge it
 * starts. `elementFromPoint` is O(1); the row walk is the fallback for a point
 * that lands on an overlay or in the gap between rows.
 */
function topRowAnchor(
  el: HTMLElement,
): { uuid: string; offset: number } | null {
  const pane = el.getBoundingClientRect();
  const hit = document.elementFromPoint(
    pane.left + pane.width / 2,
    pane.top + 1,
  );
  const row =
    hit && el.contains(hit) ? ancestorWithAttr(hit, "data-msg-row") : null;
  if (row?.dataset.msgRow) {
    return {
      uuid: row.dataset.msgRow,
      offset: row.getBoundingClientRect().top - pane.top,
    };
  }
  for (const candidate of el.querySelectorAll<HTMLElement>("[data-msg-row]")) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom <= pane.top + 1) continue;
    const uuid = candidate.dataset.msgRow;
    return uuid ? { uuid, offset: rect.top - pane.top } : null;
  }
  return null;
}

interface Props {
  messages: ConversationMessage[];
  /** Chat this transcript belongs to — keys its saved scroll position. */
  sessionId?: string;
  /** Project key — lets plan cards reach the shared annotation store for
   *  diff comments (keyed there by the plan file path). */
  encoded: string;
  /** The session's working directory — the root the changed-file pills read
   *  files against when reconstructing a turn's diff. */
  cwd?: string | null;
  annotations: ChatAnnotation[];
  onAddAnnotation: (
    anchor: ChatAnchor,
    selectedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  /** An existing comment to scroll to and open the editor on, without a click
   *  (the comment chip's jump). `nonce` re-triggers the same target. */
  revealAnnotation?: { id: string; nonce: number } | null;
  /** False while the pane is hidden (kept mounted); re-anchors on show. */
  visible?: boolean;
  /** Whether the chat's terminal is live (enables answering questions). */
  terminalReady?: boolean;
  /** Claude is actively emitting output right now — shows a typing indicator
   *  below the last message (observed from the pty stream, not a guess). */
  working?: boolean;
  /** Send raw keystrokes to the chat's terminal (drives TUI selectors). */
  onSendKeys?: (keys: string[]) => void;
}

/** The portion of one part painted for a comment/pending span. `end: null` means
 *  "to the end of the part" — the start part's tail and fully-covered middle
 *  parts. */
interface PartCover {
  start: number;
  end: number | null;
}

/** An annotation paired with the region it covers within one specific part. */
interface PartAnn {
  ann: ChatAnnotation;
  cover: PartCover;
}

/** Document-order key for a part: `<messageUuid>:<partIndex>`. */
function orderKey(messageUuid: string, partIndex: number): string {
  return `${messageUuid}:${partIndex}`;
}

/**
 * The region of the part `(uuid, partIndex)` covered by the span [start, end], or
 * null when the part lies outside the span. `order` maps each part key to its
 * document position, so this works even when the span crosses message rows.
 */
function coverForSpanPart(
  start: ChatSpan,
  end: ChatSpan,
  uuid: string,
  partIndex: number,
  order: Map<string, number>,
): PartCover | null {
  const key = orderKey(uuid, partIndex);
  const pos = order.get(key);
  const startKey = orderKey(start.messageUuid, start.partIndex);
  const endKey = orderKey(end.messageUuid, end.partIndex);
  const sPos = order.get(startKey);
  const ePos = order.get(endKey);
  if (pos === undefined || sPos === undefined || ePos === undefined)
    return null;
  if (pos < Math.min(sPos, ePos) || pos > Math.max(sPos, ePos)) return null;
  return {
    start: key === startKey ? start.offset : 0,
    end: key === endKey ? end.offset : null,
  };
}

interface EditingAnn {
  annotation: ChatAnnotation;
  pos: { top: number; left: number };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A disclosure toggle that no-ops while text is being drag-selected across it —
 *  the mouseup that ends a selection gesture also fires `click`, and expanding a
 *  block mid-selection is never what the user meant. */
function toggleUnlessSelecting(toggle: () => void): () => void {
  return () => {
    if (window.getSelection()?.isCollapsed === false) return;
    toggle();
  };
}

function previewInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input, 160);
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.command === "string") return truncate(obj.command, 160);
    if (typeof obj.pattern === "string") return obj.pattern;
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.prompt === "string") return truncate(obj.prompt, 160);
  }
  try {
    return truncate(JSON.stringify(input), 160);
  } catch {
    return "";
  }
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The plans-dir path a Write/Edit/MultiEdit targets, or null if not one. */
function planFilePath(p: MessagePart): string | null {
  if (p.kind !== "tool_use") return null;
  if (p.tool !== "Write" && p.tool !== "Edit" && p.tool !== "MultiEdit")
    return null;
  const fp = (p.input as { file_path?: unknown } | null)?.file_path;
  return typeof fp === "string" && isPlanFilePath(fp) ? fp : null;
}

/** Apply one Edit op exactly as the Edit tool does (first occurrence, or all). */
function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string {
  if (!oldStr) return content;
  if (replaceAll) return content.split(oldStr).join(newStr);
  const idx = content.indexOf(oldStr);
  return idx === -1
    ? content
    : content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

/**
 * A thinking block, shaped like {@link ToolCallBlock} — a borderless one-line
 * summary ("Thought" + the first words of the reasoning + a chevron) that
 * expands into a bordered panel. Same row height, same muted verb, so a turn's
 * thinking and its tool calls read as one column of activity lines.
 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Newlines collapsed: the summary is one line, and raw breaks would leave
  // gaps mid-row before CSS truncation kicks in.
  const preview = useMemo(
    () => truncate(text.replace(/\s+/g, " ").trim(), 200),
    [text],
  );
  return (
    <div>
      <button
        onClick={toggleUnlessSelecting(() => setOpen((v) => !v))}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]"
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">Thought</span>
        {preview && (
          <span
            className="min-w-0 truncate text-[var(--text-secondary)]"
            data-find-skip=""
          >
            {" "}
            {preview}
          </span>
        )}
        <Chevron
          open={open}
          size={12}
          className="text-[var(--text-tertiary)] duration-200"
        />
      </button>
      {/* The body is excluded from comment text (data-anno-skip): a comment
          spanning this block captures its summary line, not the reasoning. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        data-find-skip=""
        data-anno-skip=""
      >
        <div className="overflow-hidden">
          <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
            <div className="max-h-[400px] select-text overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-tertiary)] [cursor:text]">
              {text}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Plain text a message copies to the clipboard — its text parts joined. */
function messageText(m: ConversationMessage): string {
  return m.parts
    .filter(
      (p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text",
    )
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

/** How tall (px) a user bubble grows before it clips behind a "Show more". */
const USER_MESSAGE_MAX_H = 390;

/**
 * Ramp that dissolves the clipped tail of a user bubble. A mask (not a
 * background gradient) so it reads the same over the filled bubble and over the
 * transparent one an aborted prompt gets.
 */
const USER_MESSAGE_FADE =
  "linear-gradient(to bottom, #000 calc(100% - 72px), transparent)";

/**
 * User-bubble body that fades out past a max height and reveals a chevron
 * toggle. Overflow is measured off the content's scrollHeight (the full,
 * un-clamped height), so the toggle stays correct in both states.
 */
function CollapsibleUserMessage({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setOverflowing(el.scrollHeight > USER_MESSAGE_MAX_H + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clipped = overflowing && !expanded;

  return (
    <div className="relative flex w-full flex-col">
      <div
        ref={ref}
        className="flex flex-col gap-1.5 overflow-hidden"
        style={{
          maxHeight: expanded ? undefined : USER_MESSAGE_MAX_H,
          WebkitMaskImage: clipped ? USER_MESSAGE_FADE : undefined,
          maskImage: clipped ? USER_MESSAGE_FADE : undefined,
        }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          onClick={toggleUnlessSelecting(() => setExpanded((v) => !v))}
          aria-label={expanded ? "Show less" : "Show more"}
          title={expanded ? "Show less" : "Show more"}
          // Parked inside the ramp while clipped, so the tail dissolving into
          // the chevron is the whole affordance and costs no extra row.
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]",
            clipped
              ? "absolute inset-x-0 bottom-0 mx-auto"
              : "mt-0.5 self-center",
          )}
        >
          <ChevronDown
            size={14}
            className={cn("transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
    </div>
  );
}

/**
 * Copies text to the clipboard, flipping to a check only once the write
 * actually resolves — never on click alone.
 */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — leave the button unchanged rather than claim success.
    }
  }, [getText]);

  return (
    <button
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      className="text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/**
 * A tool call → a short verb + target for the header line, e.g.
 * Read → ("Read", "file.ts"), Bash → ("Ran", "<description>"). Tools without a
 * special case fall back to the raw tool name + a generic input preview.
 */
function toolHeader(
  tool: string,
  input: unknown,
): { verb: string; target: string } {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const fp = asStr(obj.file_path);
  switch (tool) {
    case "Read":
      return { verb: "Read", target: fp ? basename(fp) : "" };
    case "Edit":
    case "MultiEdit":
      return { verb: "Edit", target: fp ? basename(fp) : "" };
    case "Write":
      return { verb: "Write", target: fp ? basename(fp) : "" };
    case "Bash":
      return {
        verb: "Ran",
        target: asStr(obj.description) || truncate(asStr(obj.command), 120),
      };
    case "Grep":
      return { verb: "Grep", target: asStr(obj.pattern) };
    case "Glob":
      return { verb: "Glob", target: asStr(obj.pattern) };
    case "Skill":
      return { verb: "Skill", target: asStr(obj.skill) };
    case "SendUserFile": {
      const call = parseSendUserFile(input);
      if (!call) return { verb: tool, target: previewInput(input) };
      return {
        verb: "Sent",
        target:
          call.files.length === 1
            ? basename(call.files[0])
            : `${call.files.length} files`,
      };
    }
    default:
      return { verb: tool, target: previewInput(input) };
  }
}

/**
 * A tool call rendered as a borderless one-line summary — a muted verb, the
 * target (filename / command description), and a chevron. Clicking expands the
 * raw input (and paired result) inside a bordered panel.
 */
function ToolCallBlock({
  tool,
  input,
  inputJson,
  result,
}: {
  tool: string;
  input: unknown;
  inputJson: string;
  result?: ToolResult;
}) {
  const [open, setOpen] = useState(false);
  const { verb, target } = toolHeader(tool, input);
  const inputPreview = useMemo(() => toolPreview(tool, input), [tool, input]);
  const hover = useToolPreviewHover();

  // The base64 in an image result is megabytes, and a Read's result has to be
  // reparsed out of its "cat -n" text; do either only once something is about
  // to show it, and keep it for as long as this row lives.
  const hasImages = hasImageResult(result?.output);
  const canReadPreview = tool === "Read" && !!result && !result.isError;
  const [previewWanted, setPreviewWanted] = useState(false);
  const path = asStr(
    input && typeof input === "object"
      ? (input as Record<string, unknown>).file_path
      : "",
  );
  const imagePreview = useMemo(
    () => (previewWanted ? resultImagePreview(path, result?.output) : null),
    [previewWanted, path, result?.output],
  );
  const readPreview = useMemo(
    () =>
      previewWanted && canReadPreview
        ? readResultPreview(path, input, result?.output)
        : null,
    [previewWanted, canReadPreview, path, input, result?.output],
  );

  const preview = imagePreview ?? readPreview ?? inputPreview;
  const hoverable = hasImages || canReadPreview || !!inputPreview;
  const showPreview = () => setPreviewWanted(true);

  return (
    <div>
      <button
        onClick={toggleUnlessSelecting(() => {
          showPreview();
          setOpen((v) => !v);
        })}
        onMouseEnter={
          hoverable
            ? (e) => {
                showPreview();
                hover.onEnter(e.currentTarget.getBoundingClientRect());
              }
            : undefined
        }
        onMouseLeave={hoverable ? hover.onLeave : undefined}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]"
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">{verb}</span>
        {target && (
          <span
            className="min-w-0 truncate text-[var(--text-secondary)]"
            data-find-skip=""
          >
            {/* Explicit space so a comment spanning this row reads "Ran <target>",
                not "Ran<target>" — flex collapses it visually, textContent keeps it. */}{" "}
            {target}
          </span>
        )}
        <Chevron
          open={open}
          size={12}
          className="text-[var(--text-tertiary)] duration-200"
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        data-find-skip=""
        data-anno-skip=""
      >
        <div className="overflow-hidden">
          <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 pb-3 pt-2">
            <CodeBody text={inputJson} />
            {result && (
              <div className="mt-2 border-t border-[var(--border)] pt-2">
                <div className="mb-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  {result.isError ? "result (error)" : "result"}
                </div>
                {imagePreview ? (
                  <ResultImages srcs={imagePreview.srcs} label={path} />
                ) : (
                  <CodeBody text={result.output} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {preview &&
        hover.anchor &&
        createPortal(
          <ToolPreviewCard
            preview={preview}
            anchor={hover.anchor}
            onMouseEnter={hover.onCardEnter}
            onMouseLeave={hover.onCardLeave}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * The one-line summary a run of tool rows folds into. Shaped like the rows it
 * replaces — same mono size, same muted palette — so an open run reads as the
 * same column of activity lines it was before, under a heading.
 */
function ToolRunHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={toggleUnlessSelecting(onToggle)}
      className="flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]"
    >
      <Wrench size={11} className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 truncate text-[var(--text-secondary)]">
        {label}
      </span>
      <Chevron
        open={open}
        size={12}
        className="text-[var(--text-tertiary)] duration-200"
      />
    </button>
  );
}

/**
 * The foot of a run held at the peek cap: the rows below it are rendered as
 * nothing (not clipped — see tool-runs for why height may not be capped in
 * pixels), so the fade is drawn here rather than by an overflow box.
 */
function ToolRunMore({
  hidden,
  onShowAll,
}: {
  hidden: number;
  onShowAll: () => void;
}) {
  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-x-0 -top-7 h-7 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      <button
        onClick={toggleUnlessSelecting(onShowAll)}
        className="relative flex items-center gap-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      >
        Show {hidden} more
      </button>
    </div>
  );
}

/** Monospace, scrollable code body used inside disclosure blocks. */
function CodeBody({ text }: { text: string }) {
  return (
    <pre className="max-h-[400px] select-text overflow-auto whitespace-pre-wrap break-all font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)] [cursor:text]">
      {text}
    </pre>
  );
}

// ── Annotation highlights via the CSS Custom Highlight API ──────────
// Highlights are painted over the rendered markdown without splitting its DOM,
// so they survive rich formatting. The registry is global (per the API).

let annHighlight: Highlight | null = null;
let pendingHighlight: Highlight | null = null;

// The `::highlight()` rules live here, injected once at runtime, rather than in
// the shared globals.css: Turbopack's CSS parser (used by the web build that
// also imports that stylesheet) rejects the `::highlight()` pseudo-element.
// Theme CSS variables still resolve via the normal cascade. (Custom highlights
// support only a few paint properties — background, underline, color.)
let highlightStylesInjected = false;
function ensureHighlightStyles(): void {
  if (highlightStylesInjected) return;
  highlightStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
::highlight(chat-annotation) {
  background-color: var(--highlight-bg);
  text-decoration: underline;
  text-decoration-color: var(--text-tertiary);
  text-decoration-thickness: 1.5px;
}
::highlight(chat-annotation-pending) {
  background-color: var(--selection-bg);
}
::highlight(chat-find) {
  background-color: var(--find-match-bg, rgba(234, 179, 8, 0.32));
}
::highlight(chat-find-current) {
  background-color: var(--find-current-bg, rgba(249, 115, 22, 0.6));
}`;
  document.head.appendChild(style);
}

function getHighlights(): { ann: Highlight; pending: Highlight } | null {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return null;
  ensureHighlightStyles();
  if (!annHighlight) {
    annHighlight = new Highlight();
    pendingHighlight = new Highlight();
    CSS.highlights.set("chat-annotation", annHighlight);
    CSS.highlights.set("chat-annotation-pending", pendingHighlight);
  }
  return { ann: annHighlight, pending: pendingHighlight! };
}

// In-view find (⌘F) highlights — a separate registry from annotations.
let findHighlight: Highlight | null = null;
let findCurrentHighlight: Highlight | null = null;

function getFindHighlights(): { match: Highlight; current: Highlight } | null {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return null;
  ensureHighlightStyles();
  if (!findHighlight) {
    findHighlight = new Highlight();
    findCurrentHighlight = new Highlight();
    CSS.highlights.set("chat-find", findHighlight);
    CSS.highlights.set("chat-find-current", findCurrentHighlight);
  }
  return { match: findHighlight, current: findCurrentHighlight! };
}

/**
 * The chat surface's *annotatable* text space — the visible prose and
 * tool-summary lines. Subtrees marked `data-anno-skip` (collapsible raw bodies,
 * plan-card chrome, the in-card diff) contribute no characters, so this one
 * offset space is shared by selection capture, highlight painting, and click
 * hit-testing, and a comment never swallows a collapsed block's hidden dump.
 * The find (⌘F) space uses `data-find-skip` instead (tool-call args/output —
 * bulky and not worth searching; the tool name in the header stays searchable).
 */
const ANNO_SKIP = "data-anno-skip";
const FIND_SKIP = "data-find-skip";

/** The concatenated annotatable text of `root`. */
const annoText = (root: HTMLElement): string => textOf(root, ANNO_SKIP);

/** DOM Range for the covered region of a part. An open-ended cover (`end: null`)
 *  extends to the current end of the part's annotatable text — recomputed each
 *  paint, so it re-anchors when a block expands. */
function rangeForCover(root: HTMLElement, cover: PartCover): Range | null {
  const end = cover.end ?? annoText(root).length;
  if (end <= cover.start) return null;
  return rangeForOffsets(root, cover.start, end, ANNO_SKIP);
}

/**
 * A markdown-rendered message text part. Selection highlights, click-to-edit and
 * part addressing all live on the shared {@link PartView} now, so this is just
 * the renderer.
 */
function MarkdownText({ text }: { text: string }) {
  return (
    <div className="[cursor:text]">
      <Markdown content={text} />
    </div>
  );
}

const EMPTY_PART_ANNS: PartAnn[] = [];

function samePartCover(a: PartCover | null, b: PartCover | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

interface ToolResult {
  output: string;
  isError?: boolean;
}

function mediaUrl(path: string): string {
  // Absolute local path → file:// URL (encodeURI keeps the slashes, escapes
  // spaces in names like ".../CleanShot 2026 ….png").
  return `file://${encodeURI(path)}`;
}

/** Uniform tile a grouped attachment crops into (3:2, ~3 to a row). */
const IMAGE_TILE = "h-[86px] w-[130px]";
/** Three tiles + their gaps — the wrap point for an attachment grid. */
const IMAGE_GRID_MAX_W = 3 * 130 + 2 * 6;

function TranscriptImage({
  src,
  label,
  tiled,
  onOpen,
}: {
  src: string;
  /** Shown when the image won't render — the path it came from. */
  label: string;
  tiled: boolean;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className={cn(
          "flex flex-col justify-center rounded-[10px] border border-dashed border-[var(--border)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]",
          tiled && IMAGE_TILE,
        )}
      >
        Image unavailable
        <div className="truncate">{label}</div>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt="Attached image"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      onClick={onOpen}
      className={cn(
        "cursor-zoom-in rounded-[10px] ring-[var(--border)] transition-shadow hover:ring-1",
        tiled
          ? `${IMAGE_TILE} object-cover`
          : "max-h-[200px] max-w-[280px] object-contain",
      )}
    />
  );
}

/**
 * This part's attachments. A lone image keeps its shape (small); once a message
 * carries several they crop to uniform tiles that wrap into a grid — Claude Code
 * writes one image per part, so `all` is the whole message's set and the tiling
 * decision (and the lightbox's ←/→ range) spans parts, not just this one.
 */
function TranscriptImages({
  paths,
  all,
  offset,
}: {
  paths: string[];
  all: string[];
  offset: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  const tiled = all.length > 1;
  return (
    <>
      <div className="flex flex-wrap justify-end gap-1.5">
        {paths.map((p, i) => (
          <TranscriptImage
            key={`${i}:${p}`}
            src={mediaUrl(p)}
            label={p}
            tiled={tiled}
            onOpen={() => setAt(offset + i)}
          />
        ))}
      </div>
      {at !== null && (
        <ImageLightbox
          srcs={all.map(mediaUrl)}
          index={at}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/**
 * The images a tool result carried, shown in place of the base64 blob the
 * transcript stores. Same tile + lightbox treatment as an attached image.
 */
function ResultImages({ srcs, label }: { srcs: string[]; label: string }) {
  const [at, setAt] = useState<number | null>(null);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {srcs.map((src, i) => (
          <TranscriptImage
            key={i}
            src={src}
            label={label}
            tiled={srcs.length > 1}
            onOpen={() => setAt(i)}
          />
        ))}
      </div>
      {at !== null && (
        <ImageLightbox srcs={srcs} index={at} onClose={() => setAt(null)} />
      )}
    </>
  );
}

/**
 * A background-task notification rendered like a tool call (see ToolCallBlock):
 * a borderless one-line summary — a muted "Task" verb, a ✓/✗ status icon, the
 * summary text, and a chevron. It IS agent activity (a background process the
 * agent spawned finished), not a user message, so it reads like the other tool
 * rows. Expanding reveals the raw status / output-file / ids in a bordered panel.
 */
function TaskNotificationBlock({ n }: { n: TaskNotification }) {
  const [open, setOpen] = useState(false);
  // Success = status "completed" with a zero (or absent) exit code; anything
  // else (failed/killed, or a non-zero exit code in the summary) is a problem.
  const exitMatch = n.summary?.match(/exit code (\d+)/);
  const nonZeroExit = exitMatch ? exitMatch[1] !== "0" : false;
  const ok = (n.status ?? "completed") === "completed" && !nonZeroExit;
  // Summaries read `Background command "<cmd>" <outcome>` — the "Task" verb
  // already says it's a background command, so drop that prefix: show the
  // command itself, with the outcome ("completed (exit code 0)") muted grey.
  const summary = n.summary ?? `Background task ${n.status ?? "updated"}`;
  const cmdMatch = summary.match(/^Background command "(.+)" (.+)$/);
  const command = cmdMatch ? cmdMatch[1] : summary;
  const outcome = cmdMatch ? cmdMatch[2] : null;
  const details: Array<[string, string]> = [];
  if (n.status) details.push(["status", n.status]);
  if (n.outputFile) details.push(["output", n.outputFile]);
  if (n.taskId) details.push(["task", n.taskId]);
  return (
    <div>
      <button
        onClick={toggleUnlessSelecting(() => setOpen((v) => !v))}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]"
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">Task</span>
        <span
          className="min-w-0 truncate text-[var(--text-secondary)]"
          data-find-skip=""
        >
          {/* Leading space so a spanning comment reads "Task <command>". */}{" "}
          {command}
          {outcome && (
            <span
              className={cn(
                "ml-1.5",
                ok
                  ? "text-[var(--text-tertiary)]"
                  : "text-[var(--removed-text,#f87171)]",
              )}
            >
              {" "}
              {outcome}
            </span>
          )}
        </span>
        <Chevron
          open={open}
          size={12}
          className="text-[var(--text-tertiary)] duration-200"
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        data-find-skip=""
        data-anno-skip=""
      >
        <div className="overflow-hidden">
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 pb-3 pt-2 font-[family-name:var(--font-mono)] text-[11px]">
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[var(--text-tertiary)]">{k}</dt>
                <dd className="min-w-0 break-all text-[var(--text-secondary)]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

/**
 * A slash-command invocation. Claude Code echoes the command as a user turn
 * whose text is a structured block:
 *   <command-message>grill-me</command-message>
 *   <command-name>/grill-me</command-name>
 *   <command-args>…</command-args>
 * The CLI renders this as a compact `› /grill-me <args>` line, not the raw tag
 * soup — mirror that. (The expanded skill body arrives as a separate isMeta
 * turn, rendered by SystemMetaBlock.)
 */
function parseCommandInvocation(
  text: string,
): { name: string; args: string } | null {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const name = nameMatch[1].trim();
  return {
    name: name.startsWith("/") ? name : `/${name}`,
    args: argsMatch ? argsMatch[1].trim() : "",
  };
}

/**
 * Harness-injected turns (isMeta / promptSource:"system") are machinery, not
 * user input: expanded skill bodies, autonomous-loop ticks, context caveats.
 * They render exactly like a tool call (see ToolCallBlock) — a muted verb, a
 * target, a chevron. The *gate* (treat-as-system) is driven by the reliable
 * metadata; only this verb/target is derived from the body, and it falls back
 * to a generic "System" so a mislabel can't hide content.
 */
function systemMetaHeader(text: string): { verb: string; target: string } {
  const t = text.trimStart();
  if (/^#\s*Autonomous loop/i.test(t) || t.includes("Autonomous loop tick")) {
    return { verb: "Autonomous loop", target: "wakeup tick" };
  }
  const skill = t.match(/^Base directory for this skill:\s*(.+)$/m);
  if (skill) {
    const slug = skill[1].trim().split("/").filter(Boolean).pop() ?? "skill";
    return { verb: "Ran skill", target: slug };
  }
  return { verb: "System", target: "" };
}

/**
 * A harness-injected turn rendered like a tool call: a borderless one-line
 * summary (muted verb + target + chevron); expanding reveals the raw injected
 * text in a bordered panel. Mirrors ToolCallBlock so it reads as machinery.
 */
function SystemMetaBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = systemMetaHeader(text);
  return (
    <div>
      <button
        onClick={toggleUnlessSelecting(() => setOpen((v) => !v))}
        className="flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]"
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">{verb}</span>
        {target && (
          <span
            className="min-w-0 truncate text-[var(--text-secondary)]"
            data-find-skip=""
          >
            {" "}
            {target}
          </span>
        )}
        <Chevron
          open={open}
          size={12}
          className="text-[var(--text-tertiary)] duration-200"
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        data-find-skip=""
        data-anno-skip=""
      >
        <div className="overflow-hidden">
          <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 pb-3 pt-2">
            <CodeBody text={text} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A locally-executed slash command's output (/model, /compact, …) rendered like
 * the other machinery rows (see SystemMetaBlock): a muted "Output" verb plus
 * the first line of the output. When there's more than one line, a chevron
 * expands the full text in a bordered panel.
 */
function LocalCommandOutputBlock({
  stdout,
  stderr,
}: {
  stdout: string | null;
  stderr: string | null;
}) {
  const [open, setOpen] = useState(false);
  const out = stdout?.trim() ?? "";
  const err = stderr?.trim() ?? "";
  const full = [out, err].filter((v) => v !== "").join("\n");
  const summary = full.split("\n")[0] || "(no output)";
  const expandable = full.includes("\n");
  return (
    <div>
      <button
        onClick={toggleUnlessSelecting(() => expandable && setOpen((v) => !v))}
        className={cn(
          "flex w-full items-center gap-1.5 py-0.5 text-left font-[family-name:var(--font-mono)] text-[11px]",
          !expandable && "cursor-default",
        )}
      >
        <span className="shrink-0 text-[var(--text-tertiary)]">Output</span>
        <span
          className={cn(
            "min-w-0 truncate",
            err !== "" && out === ""
              ? "text-[var(--removed-text,#f87171)]"
              : "text-[var(--text-secondary)]",
          )}
          data-find-skip=""
        >
          {" "}
          {summary}
        </span>
        {expandable && (
          <Chevron
            open={open}
            size={12}
            className="text-[var(--text-tertiary)] duration-200"
          />
        )}
      </button>
      {expandable && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
          data-find-skip=""
          data-anno-skip=""
        >
          <div className="overflow-hidden">
            <div className="mt-1 select-text rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 pb-3 pt-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
              {out !== "" && (
                <pre className="whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                  {out}
                </pre>
              )}
              {err !== "" && (
                <pre className="whitespace-pre-wrap break-all text-[var(--removed-text,#f87171)]">
                  {err}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BashBlock({
  input,
  stdout,
  stderr,
}: {
  input: string | null;
  stdout: string | null;
  stderr: string | null;
}) {
  const out = stdout?.replace(/\n+$/, "") ?? "";
  const err = stderr?.replace(/\n+$/, "") ?? "";
  return (
    <div className="select-text font-[family-name:var(--font-mono)] text-[12px] leading-relaxed [cursor:text]">
      {input !== null && (
        <div className="flex gap-2">
          <span className="shrink-0 select-none text-[var(--text-tertiary)]">
            $
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-all text-[var(--text)]">
            {input}
          </span>
        </div>
      )}
      {out !== "" && (
        <pre className="whitespace-pre-wrap break-all text-[var(--text-secondary)]">
          {out}
        </pre>
      )}
      {err !== "" && (
        <pre className="whitespace-pre-wrap break-all text-[var(--removed-text,#f87171)]">
          {err}
        </pre>
      )}
    </div>
  );
}

interface MessagePartViewProps {
  part: MessagePart;
  message: ConversationMessage;
  /** The tool_result paired with this tool_use part (rendered inline). */
  result?: ToolResult;
  /** Whether the chat's terminal is live (enables answering questions). */
  terminalReady: boolean;
  /** Send raw keystrokes to the chat's terminal (drives TUI selectors). */
  onSendKeys?: (keys: string[]) => void;
  /** All ExitPlanMode versions in the session, in order (for a plan part). */
  planVersions: PlanVersionInfo[];
  /** This part's index into `planVersions`, or -1 if it isn't a plan. */
  planVersionIndex: number;
  /** Project key — for the plan card's diff comments (shared annotation store). */
  encoded: string;
}

/** The rendered content of one part (the kind switch). The selectable host,
 *  highlight painting and click-to-edit live on {@link PartView}, which wraps
 *  this. */
function renderPartContent({
  part,
  message,
  result,
  terminalReady,
  onSendKeys,
  planVersions,
  planVersionIndex,
  encoded,
}: MessagePartViewProps): React.ReactNode {
  switch (part.kind) {
    case "text": {
      const imgPaths = imageOnlyPaths(part.text);
      if (imgPaths) {
        const all: string[] = [];
        let offset = 0;
        for (const p of message.parts) {
          if (p === part) offset = all.length;
          if (p.kind === "text") all.push(...(imageOnlyPaths(p.text) ?? []));
        }
        return <TranscriptImages paths={imgPaths} all={all} offset={offset} />;
      }
      // A slash-command the user typed: strip the `<command-*>` tag soup and
      // render the clean `/cmd args` as normal bubble text (it IS user input).
      const command = parseCommandInvocation(part.text);
      if (command) {
        const clean = command.args
          ? `${command.name} ${command.args}`
          : command.name;
        return <MarkdownText text={clean} />;
      }
      const bash = parseBashBlock(part.text);
      if (bash) {
        return (
          <BashBlock
            input={bash.input}
            stdout={bash.stdout}
            stderr={bash.stderr}
          />
        );
      }
      const localOutput = parseLocalCommandOutput(part.text);
      if (localOutput) {
        return (
          <LocalCommandOutputBlock
            stdout={localOutput.stdout}
            stderr={localOutput.stderr}
          />
        );
      }
      const tasks = parseTaskNotifications(part.text);
      if (tasks) {
        return (
          <div className="flex flex-col gap-1.5">
            {tasks.notifications.map((n, i) => (
              <TaskNotificationBlock key={n.taskId ?? i} n={n} />
            ))}
            {tasks.remainder && <MarkdownText text={tasks.remainder} />}
          </div>
        );
      }
      const interruption = interruptionKind(part.text);
      if (interruption) {
        return <InterruptedRow kind={interruption} />;
      }
      if (message.isMeta || message.promptSource === "system") {
        return <SystemMetaBlock text={part.text} />;
      }
      return <MarkdownText text={part.text} />;
    }
    case "thinking":
      return <ThinkingBlock text={part.text} />;
    case "tool_use": {
      // AskUserQuestion gets a rich card: question + options, clickable while
      // pending (drives the TUI selector via keystrokes).
      if (part.tool === "AskUserQuestion") {
        const questions = parseAskInput(part.input);
        if (questions) {
          return (
            <AskQuestionCard
              questions={questions}
              resultText={result?.output}
              canAnswer={terminalReady && !!onSendKeys}
              onPick={(index) =>
                // Selector starts on option 1: ↓ × index, then Enter.
                onSendKeys?.([
                  ...Array.from({ length: index }, () => "\x1b[B"),
                  "\r",
                ])
              }
            />
          );
        }
      }
      // The plan renders as a clean inline Plan card (anchored on the plan-file
      // Write), not a raw tool block. The body goes through the same
      // annotation-aware markdown path as normal assistant text, so selecting it
      // comments via the existing chat flow.
      if (planVersionIndex >= 0) {
        const planText = planVersions[planVersionIndex]?.text ?? "";
        return (
          <PlanCard
            versions={planVersions}
            versionIndex={planVersionIndex}
            encoded={encoded}
            planPath={planFilePath(part)}
            body={<MarkdownText text={planText} />}
          />
        );
      }
      // A delivered file gets its own row: the caption inline, an Open control,
      // and the file itself on hover. A failed send falls through to the raw
      // block instead — the error is the only thing worth showing then.
      if (part.tool === "SendUserFile" && !result?.isError) {
        const call = parseSendUserFile(part.input);
        if (call) {
          return <SentFileBlock files={call.files} caption={call.caption} />;
        }
      }
      let inputJson: string;
      try {
        inputJson = JSON.stringify(part.input, null, 2);
      } catch {
        inputJson = String(part.input);
      }
      return (
        <ToolCallBlock
          tool={part.tool}
          input={part.input}
          inputJson={inputJson}
          result={result}
        />
      );
    }
    case "tool_result":
      // Rendered inline within its tool_use block (see `result`); skip here.
      return null;
  }
}

interface PartViewProps extends MessagePartViewProps {
  messageUuid: string;
  partIndex: number;
  /** Annotation covers for this part (see annotationsByMessage). */
  partAnns: PartAnn[];
  /** The in-flight selection's cover for this part, if any. */
  pendingCover: PartCover | null;
  /** Bumped when the pane returns from display:none so covers re-register —
   *  Chromium won't repaint custom highlights held across a hidden spell. */
  repaintNonce: number;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
}

/**
 * One message part, memoized, as a selectable host tagged with its
 * (message, part) coordinates. It paints the custom highlights for any
 * annotation covering this part plus the in-flight pending selection, and
 * hit-tests clicks to open the editor. Hosting every part uniformly — text AND
 * tool blocks — is what lets a selection (and its comment) span the tool rows
 * ("Ran …/filename") and turns between two paragraphs.
 */
const PartView = memo(
  function PartView(props: PartViewProps) {
    const {
      messageUuid,
      partIndex,
      partAnns,
      pendingCover,
      repaintNonce,
      onClickAnnotation,
      ...content
    } = props;
    const ref = useRef<HTMLDivElement>(null);

    // Only touch the highlight registry for parts that actually have something to
    // paint, and only observe resizes when a cover is open-ended ("to end of
    // part") and so must re-anchor as the part grows (a tool block expanding).
    // The vast majority of parts fall through both guards — no observer, no work.
    useLayoutEffect(() => {
      const root = ref.current;
      const hl = getHighlights();
      if (!root || !hl) return;
      if (partAnns.length === 0 && !pendingCover) return;
      let added: Array<{ set: Highlight; range: Range }> = [];
      const paint = () => {
        for (const pa of partAnns) {
          const r = rangeForCover(root, pa.cover);
          if (r) {
            hl.ann.add(r);
            added.push({ set: hl.ann, range: r });
          }
        }
        if (pendingCover) {
          const r = rangeForCover(root, pendingCover);
          if (r) {
            hl.pending.add(r);
            added.push({ set: hl.pending, range: r });
          }
        }
      };
      const clear = () => {
        for (const a of added) a.set.delete(a.range);
        added = [];
      };
      paint();
      const openEnded =
        partAnns.some((p) => p.cover.end === null) ||
        pendingCover?.end === null;
      if (!openEnded) return clear;
      const ro = new ResizeObserver(() => {
        clear();
        paint();
      });
      ro.observe(root);
      return () => {
        ro.disconnect();
        clear();
      };
    }, [partAnns, pendingCover, repaintNonce]);

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        if (partAnns.length === 0) return;
        const root = ref.current;
        if (!root) return;
        const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (!caret) return;
        const off = offsetWithin(
          root,
          caret.startContainer,
          caret.startOffset,
          ANNO_SKIP,
        );
        if (off === -1) return;
        const hit = partAnns.find((pa) => {
          const end = pa.cover.end ?? annoText(root).length;
          return pa.cover.start <= off && off < end;
        });
        if (!hit) return;
        e.stopPropagation();
        const r = rangeForCover(root, hit.cover);
        const rect = r?.getBoundingClientRect() ?? root.getBoundingClientRect();
        onClickAnnotation(hit.ann, rect);
      },
      [partAnns, onClickAnnotation],
    );

    return (
      <div
        ref={ref}
        data-part-root=""
        data-message-uuid={messageUuid}
        data-part-index={partIndex}
        onClick={handleClick}
        className="select-text"
      >
        {renderPartContent(content)}
      </div>
    );
  },
  // Message/part objects keep their identity across session refreshes (see
  // mergeSession), so reference checks suffice — except the paired tool result
  // (rebuilt each parse, compared by content) and the pending cover (a fresh
  // object each render, compared by value). partAnns is referentially stable
  // (memoized) until the annotations actually change.
  (prev, next) =>
    prev.part === next.part &&
    prev.message === next.message &&
    prev.messageUuid === next.messageUuid &&
    prev.partIndex === next.partIndex &&
    prev.partAnns === next.partAnns &&
    prev.repaintNonce === next.repaintNonce &&
    prev.onClickAnnotation === next.onClickAnnotation &&
    prev.terminalReady === next.terminalReady &&
    prev.onSendKeys === next.onSendKeys &&
    prev.planVersions === next.planVersions &&
    prev.planVersionIndex === next.planVersionIndex &&
    prev.encoded === next.encoded &&
    samePartCover(prev.pendingCover, next.pendingCover) &&
    sameResult(prev.result, next.result),
);

function sameResult(a?: ToolResult, b?: ToolResult): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.output === b.output && a.isError === b.isError;
}

// Stable reference for non-plan parts so the memoized part view doesn't re-render
// every time `messages` changes (only plan parts read the versions array).
const EMPTY_PLAN_VERSIONS: PlanVersionInfo[] = [];
const EMPTY_RUN_KEYS: ReadonlySet<string> = new Set();

/**
 * Memoized: the composer's state lives in the workspace, so without this every
 * keystroke would re-render the entire (non-virtualized) transcript.
 */
export const MessageList = memo(function MessageList({
  messages,
  sessionId,
  encoded,
  cwd = null,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  revealAnnotation,
  visible = true,
  terminalReady = false,
  working = false,
  onSendKeys,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Building the whole transcript (markdown for every text part) is the cost
  // that froze the pane on a chat switch. Defer it: React keeps showing the
  // current chat and builds the new one in a low-priority, interruptible pass,
  // so the switch never hard-blocks the main thread. Everything below derives
  // from `deferredMessages` so each render pass is internally consistent — no
  // virtualization, so natural document flow (and stable scrolling) is intact.
  const deferredMessages = useDeferredValue(messages);

  // Pair tool_result → tool_use (by id) so results render inside their tool
  // block, and drop the now-empty result-only messages from the timeline.
  const resultByToolUseId = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const m of deferredMessages) {
      for (const p of m.parts) {
        if (p.kind === "tool_result") {
          map.set(p.toolUseId, { output: p.output, isError: p.isError });
        }
      }
    }
    return map;
  }, [deferredMessages]);

  const items = useMemo(
    () =>
      deferredMessages.filter(
        (m) => !m.parts.every((p) => p.kind === "tool_result"),
      ),
    [deferredMessages],
  );

  // Derived per render rather than carried on the message: whether a prompt was
  // abandoned only becomes knowable when LATER lines land, and `session:read`
  // sends appends only — a flag baked in at parse time would stay stale on the
  // rows the renderer already holds. Runs over the unfiltered list because the
  // cutoff reads file order across tool turns too.
  const abortedPrompts = useMemo(
    () => abortedPromptUuids(deferredMessages),
    [deferredMessages],
  );

  // The reply meta row (time + copy) shows on exactly ONE row: the LAST row of
  // the newest assistant turn, so it lands at the visual end of the reply even
  // when that turn trails off into tool calls. Copy still pulls the prose from
  // the last text row of the same turn. Null while the reply carries no prose.
  const replyMeta = useMemo(() => {
    let last = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (isRealUserTurn(items[i])) break;
      if (last < 0) last = i;
      const text = messageText(items[i]).trim();
      if (text) return { idx: last, text };
    }
    return null;
  }, [items]);

  // Files each turn wrote to, keyed by the turn's last row — the pill strip
  // that closes a reply. Same anchor as the reply meta row, so a turn ends with
  // its prose, then what it changed, then the time.
  const turnFilesByRow = useMemo(() => turnFileChangesByRow(items), [items]);

  // The inline plan card is sourced from the plan FILE Claude writes to
  // ~/.claude/plans/ (see planFilePath): each Write is a new revision, and
  // Edits/MultiEdits fold into the latest revision's text — all reconstructed
  // from the transcript so the plan shows the instant the Write lands, not when
  // ExitPlanMode is approved. `byPart` maps a Write part → its version index
  // (where the card renders); `hidden` is the Edit/MultiEdit/ExitPlanMode parts
  // the card subsumes (rendered as nothing). When a session has no plan-file
  // writes we fall back to ExitPlanMode's own content — the only signal left.
  const { planVersions, planVersionByPart, hiddenParts } = useMemo(() => {
    const versions: PlanVersionInfo[] = [];
    const byPart = new Map<string, number>();
    const hidden = new Set<string>();

    const hasPlanWrites = deferredMessages.some((m) =>
      m.parts.some(
        (p) => p.kind === "tool_use" && p.tool === "Write" && planFilePath(p),
      ),
    );

    if (!hasPlanWrites) {
      for (const m of deferredMessages) {
        m.parts.forEach((p, i) => {
          if (p.kind !== "tool_use" || p.tool !== "ExitPlanMode") return;
          const text = parsePlanInput(p.input);
          if (text === null) return;
          byPart.set(`${m.uuid}:${i}`, versions.length);
          versions.push({ text, timestamp: m.timestamp });
        });
      }
      return {
        planVersions: versions,
        planVersionByPart: byPart,
        hiddenParts: hidden,
      };
    }

    const content = new Map<string, string>(); // path → current reconstructed text
    const lastVersion = new Map<string, number>(); // path → its latest version idx
    for (const m of deferredMessages) {
      m.parts.forEach((p, i) => {
        const key = `${m.uuid}:${i}`;
        if (p.kind === "tool_use" && p.tool === "ExitPlanMode") {
          hidden.add(key);
          return;
        }
        const path = planFilePath(p);
        if (!path || p.kind !== "tool_use") return;
        const input = (p.input ?? {}) as Record<string, unknown>;
        if (p.tool === "Write") {
          const text = asStr(input.content);
          content.set(path, text);
          byPart.set(key, versions.length);
          lastVersion.set(path, versions.length);
          versions.push({ text, timestamp: m.timestamp });
          return;
        }
        // Edit / MultiEdit refine the file → update the latest revision in place.
        let text = content.get(path) ?? "";
        if (p.tool === "Edit") {
          text = applyEdit(
            text,
            asStr(input.old_string),
            asStr(input.new_string),
            input.replace_all === true,
          );
        } else {
          const edits = Array.isArray(input.edits) ? input.edits : [];
          for (const e of edits) {
            const eo = (e ?? {}) as Record<string, unknown>;
            text = applyEdit(
              text,
              asStr(eo.old_string),
              asStr(eo.new_string),
              eo.replace_all === true,
            );
          }
        }
        content.set(path, text);
        const vi = lastVersion.get(path);
        if (vi !== undefined) versions[vi] = { ...versions[vi], text };
        hidden.add(key);
      });
    }
    return {
      planVersions: versions,
      planVersionByPart: byPart,
      hiddenParts: hidden,
    };
  }, [deferredMessages]);
  const [editing, setEditing] = useState<EditingAnn | null>(null);

  // Document position of every part, so a comment span can be resolved across
  // message rows (the selection the user makes routinely crosses turns). Key is
  // `<uuid>:<partIndex>`; the value is its 0-based order in the transcript.
  const partOrder = useMemo(() => {
    const order = new Map<string, number>();
    let n = 0;
    for (const m of deferredMessages) {
      for (let i = 0; i < m.parts.length; i++)
        order.set(orderKey(m.uuid, i), n++);
    }
    return order;
  }, [deferredMessages]);

  // A span attaches to every part between its endpoints (across rows) with the
  // region it covers there (start part → its tail, middle parts → whole, end part
  // → its head). Each PartView then paints its own slice.
  const annotationsByMessage = useMemo(() => {
    const map = new Map<string, Map<number, PartAnn[]>>();
    const add = (uuid: string, part: number, pa: PartAnn) => {
      let m = map.get(uuid);
      if (!m) {
        m = new Map();
        map.set(uuid, m);
      }
      const list = m.get(part) ?? [];
      list.push(pa);
      m.set(part, list);
    };
    for (const a of annotations) {
      const sPos = partOrder.get(
        orderKey(a.start.messageUuid, a.start.partIndex),
      );
      const ePos = partOrder.get(orderKey(a.end.messageUuid, a.end.partIndex));
      if (sPos === undefined || ePos === undefined) continue;
      for (const m of deferredMessages) {
        for (let i = 0; i < m.parts.length; i++) {
          const pos = partOrder.get(orderKey(m.uuid, i));
          if (
            pos === undefined ||
            pos < Math.min(sPos, ePos) ||
            pos > Math.max(sPos, ePos)
          )
            continue;
          const cover = coverForSpanPart(a.start, a.end, m.uuid, i, partOrder);
          if (cover) add(m.uuid, i, { ann: a, cover });
        }
      }
    }
    return map;
  }, [annotations, deferredMessages, partOrder]);

  // Runs of consecutive tool/thinking rows fold behind one summary line. A part
  // that renders as a card (plan, question, delivered file) is content, not
  // machinery, so it breaks the run rather than folding into it.
  const toolRuns = useMemo(
    () =>
      findToolRuns(items, (m, i, p) => {
        const key = `${m.uuid}:${i}`;
        if (hiddenParts.has(key) || planVersionByPart.has(key)) return true;
        if (p.kind !== "tool_use") return false;
        if (p.tool === "AskUserQuestion")
          return parseAskInput(p.input) !== null;
        if (p.tool === "SendUserFile")
          return (
            resultByToolUseId.get(p.id)?.isError !== true &&
            parseSendUserFile(p.input) !== null
          );
        return false;
      }),
    [items, hiddenParts, planVersionByPart, resultByToolUseId],
  );
  const [openRunKeys, setOpenRunKeys] =
    useState<ReadonlySet<string>>(EMPTY_RUN_KEYS);
  const [fullRunKeys, setFullRunKeys] =
    useState<ReadonlySet<string>>(EMPTY_RUN_KEYS);

  const toggleRun = useCallback((key: string) => {
    setOpenRunKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const showWholeRun = useCallback((key: string) => {
    setFullRunKeys((prev) => new Set(prev).add(key));
  }, []);

  /** Runs that may not fold, whatever the reader clicked. */
  const forcedRunKeys = useMemo(() => {
    const out = new Set<string>();
    for (const run of toolRuns.runs) {
      for (let i = run.start; i <= run.end; i++) {
        // A comment anchors to a part inside this run; folded, it would have
        // nothing to paint and the comment would read as lost.
        if (annotationsByMessage.has(items[i].uuid)) {
          out.add(run.key);
          break;
        }
      }
    }
    // The run Claude is still adding to: folding it hides the only progress the
    // transcript shows while a reply is in flight.
    const last = toolRuns.runs[toolRuns.runs.length - 1];
    if (working && last && last.end === items.length - 1) out.add(last.key);
    return out;
  }, [toolRuns, items, annotationsByMessage, working]);

  /** Per-row "should we show the role header here?" */
  const showHeaderForRow = useMemo(() => {
    const out: boolean[] = [];
    let prevCat: MessageCategory | null = null;
    for (const m of items) {
      const cat = classifyMessage(m);
      // Tool/machinery rows never show a header, and don't break the turn:
      // an assistant row resuming after a System interlude stays headerless.
      if (cat === "tool") {
        out.push(false);
        continue;
      }
      out.push(cat !== prevCat);
      prevCat = cat;
    }
    return out;
  }, [items]);

  // Every row stays mounted — find, comment selection, annotations and the
  // message rail all read this DOM. What varies is which rows are RENDERED:
  // see useRowWindow, which reserves a measured height for the rest.
  const contentRef = useRef<HTMLDivElement>(null);
  // The find indexer renders a slice at a time to read its text. Declared here
  // because the window is built before `find` further down.
  const [findForceRange, setFindForceRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [indexing, setIndexing] = useState(false);
  const rowWindow = useRowWindow(
    parentRef,
    contentRef,
    items,
    findForceRange,
    indexing,
  );
  // Folding a run resizes the document under the reader. The window's own
  // anchor absorbs that, but only on a pass — so ask for one.
  useLayoutEffect(() => {
    rowWindow.schedule();
  }, [openRunKeys, fullRunKeys, rowWindow.schedule]);
  const scrollKey = sessionId ? chatScrollKey(encoded, sessionId) : null;
  const scrollKeyRef = useRef<string | null>(null);
  // Anchor to restore to (null = never scrolled this session, or it was left at
  // the bottom). Seeded from the module store, which outlives both this pane's
  // hidden state and a workspace remount.
  const savedRef = useRef<ChatScrollPos | null>(null);
  const followingBottomRef = useRef(true);
  if (scrollKeyRef.current !== scrollKey) {
    scrollKeyRef.current = scrollKey;
    savedRef.current = scrollKey ? getChatScroll(scrollKey) : null;
    followingBottomRef.current = savedRef.current?.atBottom ?? true;
  }
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Chromium doesn't repaint custom-highlight ranges that lived through an
  // ancestor's display:none (the keep-alive pool hides inactive workspaces/tabs
  // instead of unmounting), so bump a nonce on re-show to re-register them.
  const [repaintNonce, setRepaintNonce] = useState(0);
  const wasHiddenRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      wasHiddenRef.current = true;
      return;
    }
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      setRepaintNonce((n) => n + 1);
    }
  }, [visible]);

  const [showScrollDown, setShowScrollDown] = useState(false);

  // Offset this component last put the scroller at — anything else is someone
  // else moving it (see onScroll).
  const appliedScrollRef = useRef(-1);

  // Where the restore wants the scroller, applied against the CURRENT layout.
  const applyScrollTarget = useCallback(() => {
    const el = parentRef.current;
    if (!el || !el.checkVisibility()) return;
    const pos = savedRef.current;
    if (followingBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (!pos) {
      return;
    } else {
      const row = pos.anchorUuid
        ? el.querySelector<HTMLElement>(
            `[data-msg-row="${CSS.escape(pos.anchorUuid)}"]`,
          )
        : null;
      if (!row) {
        el.scrollTop = pos.scrollTop;
      } else {
        const want = pos.anchorOffset - (pos.scrollTop - pos.anchorScrollTop);
        const delta =
          row.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          want;
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
      }
    }
    appliedScrollRef.current = el.scrollTop;
  }, []);

  // A restore has to survive the transcript settling: rows are
  // content-visibility'd (off-screen heights are estimates until rendered) and
  // markdown/shiki/images resolve after the first paint, so the scroller keeps
  // growing for a few frames. A one-shot restore lands wherever those estimates
  // happened to put it — near the top of a long chat — so re-apply the target
  // until it stops moving or the user takes over.
  const settleUntilRef = useRef(0);
  const rafRef = useRef(0);

  const beginRestore = useCallback(() => {
    settleUntilRef.current = performance.now() + RESTORE_SETTLE_MS;
    applyScrollTarget();
    if (rafRef.current) return;
    const tick = () => {
      rafRef.current = 0;
      if (performance.now() > settleUntilRef.current) return;
      applyScrollTarget();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [applyScrollTarget]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Pick the render window BEFORE anything reads layout. The restore below
  // reads scrollHeight, and that first read lays out whatever is rendered at
  // the time — every row, if this has not run yet.
  useLayoutEffect(() => {
    if (!visible) return;
    rowWindow.sync();
  }, [visible, items, rowWindow]);

  // Restore on mount and every time the pane comes back on screen — a hidden
  // pane has no layout box, so the browser drops its scroll offset.
  useLayoutEffect(() => {
    if (!visible) return;
    beginRestore();
  }, [visible, beginRestore]);

  // Keep the bottom pinned as new content lands. `working` is a dep so the
  // typing indicator appearing/disappearing keeps us anchored too.
  useLayoutEffect(() => {
    if (visibleRef.current && followingBottomRef.current) applyScrollTarget();
  }, [items.length, deferredMessages, working, applyScrollTarget]);

  // Rows grow after their row is committed (shiki, images, a
  // content-visibility'd row rendering for real), which silently walks the
  // viewport away from wherever it was pinned.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      // A row that just grew (shiki, an image) has a stale reservation.
      rowWindow.schedule();
      if (followingBottomRef.current) applyScrollTarget();
      else if (performance.now() < settleUntilRef.current) applyScrollTarget();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [applyScrollTarget, rowWindow]);

  // Record the position so returning to this chat resumes where it was left.
  // scrollTop lands on every event (cheap); the anchor row is sampled once
  // movement stops, and any scrolling since is replayed off `anchorScrollTop`.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let settleTimer = 0;

    const save = (anchor: boolean) => {
      const prev = savedRef.current;
      const pos: ChatScrollPos = {
        atBottom: followingBottomRef.current,
        scrollTop: el.scrollTop,
        anchorUuid: prev?.anchorUuid ?? null,
        anchorOffset: prev?.anchorOffset ?? 0,
        anchorScrollTop: prev?.anchorScrollTop ?? el.scrollTop,
      };
      if (anchor) {
        const found = topRowAnchor(el);
        pos.anchorUuid = found?.uuid ?? null;
        pos.anchorOffset = found?.offset ?? 0;
        pos.anchorScrollTop = el.scrollTop;
      }
      savedRef.current = pos;
      if (scrollKey) setChatScroll(scrollKey, pos);
    };

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollDown(distance > SCROLL_DOWN_THRESHOLD_PX);
      // A hidden pane reports a collapsed scroller — not the user's position.
      if (!visibleRef.current) return;
      if (performance.now() < settleUntilRef.current) {
        // A restore in flight moves the scroller itself; ignore those. An offset
        // we didn't put there is someone else driving (a wheel, the message
        // overview rail, find) — they win, so the restore stands down.
        if (Math.abs(el.scrollTop - appliedScrollRef.current) <= 1) return;
        settleUntilRef.current = 0;
      }
      followingBottomRef.current = distance < BOTTOM_EPSILON_PX;
      save(false);
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => save(true), ANCHOR_SAMPLE_MS);
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(settleTimer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollKey]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    settleUntilRef.current = 0;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    followingBottomRef.current = true;
    setShowScrollDown(false);
  }, []);

  // Selection → comment popover. A selection routinely crosses parts AND turns
  // (prose, the tool rows between them, and separate messages), so this maps the
  // settled DOM selection to a document-order span {start, end}, each an
  // (messageUuid, partIndex, offset). Timing (when the selection has settled,
  // releases outside the pane) is handled upstream by useCommentSelection.
  const resolveSelection = useCallback((range: Range) => {
    const pane = parentRef.current;
    if (!pane) return null;
    if (!pane.contains(range.commonAncestorContainer)) return null;

    // A selection whose endpoint sits inside a raw/expandable body or an in-card
    // diff (data-anno-skip) isn't ours — those surfaces handle their own
    // comments (or aren't commentable). Ignore it rather than mis-anchor.
    if (
      ancestorWithAttr(range.startContainer, "data-anno-skip") ||
      ancestorWithAttr(range.endContainer, "data-anno-skip")
    ) {
      return null;
    }

    // Resolve each endpoint to its part wrapper. Fall each back to the other so a
    // triple-click landing its end boundary just past a block (on an element with
    // no data-part-root) still resolves.
    const startPart =
      ancestorWithAttr(range.startContainer, "data-part-root") ??
      ancestorWithAttr(range.endContainer, "data-part-root");
    const endPart =
      ancestorWithAttr(range.endContainer, "data-part-root") ?? startPart;
    if (!startPart || !endPart) return null;

    // Order the two endpoints by document position over every part in the pane,
    // so `first` is the document-earlier part regardless of which row it's in.
    const allParts = Array.from(
      pane.querySelectorAll<HTMLElement>("[data-part-root]"),
    );
    const si = allParts.indexOf(startPart);
    const ei = allParts.indexOf(endPart);
    if (si === -1 || ei === -1) return null;
    const lo = Math.min(si, ei);
    const hi = Math.max(si, ei);
    const firstEl = allParts[lo];
    const lastEl = allParts[hi];

    // Offset of each endpoint within its part. The range's boundaries lie in the
    // document-first and document-last parts respectively.
    const firstOffs = selectedOffsetsWithin(firstEl, range, ANNO_SKIP);
    if (!firstOffs) return null;
    const lastOffs =
      firstEl === lastEl
        ? firstOffs
        : selectedOffsetsWithin(lastEl, range, ANNO_SKIP);

    const start: ChatSpan = {
      messageUuid: msgUuidOf(firstEl),
      partIndex: partIndexOf(firstEl),
      offset: firstOffs.start,
    };
    const end: ChatSpan = {
      messageUuid: msgUuidOf(lastEl),
      partIndex: partIndexOf(lastEl),
      offset: lastOffs ? lastOffs.end : annoText(lastEl).length,
    };

    // Trim whitespace at the two ends so the highlight and captured text don't
    // include a trailing blank line / leading indent.
    const firstText = annoText(firstEl);
    while (
      start.offset < firstText.length &&
      /\s/.test(firstText[start.offset])
    )
      start.offset++;
    const lastText = annoText(lastEl);
    while (end.offset > 0 && /\s/.test(lastText[end.offset - 1])) end.offset--;

    if (firstEl === lastEl && start.offset >= end.offset) return null;

    // Build the captured text from the same covers that paint the highlight, so
    // the two never disagree — collapsed tool bodies are excluded (annoText), the
    // visible "Ran …/filename" summary lines are kept.
    const pieces: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const el = allParts[i];
      const from = el === firstEl ? start.offset : 0;
      const t = annoText(el);
      const to = el === lastEl ? end.offset : t.length;
      const piece = t.slice(from, to).trim();
      if (piece) pieces.push(piece);
    }
    const selectedText = pieces.join("\n");
    if (!selectedText) return null;

    // Anchor the popover to the LAST visible line of the selection, not the raw
    // bounding box: a tall multi-line range's box picks up a zero-size rect at
    // its end boundary that can sit far below the last line, dropping the popover
    // way down. CommentPopover clamps itself into the viewport.
    const anchor = lastLineRect(range);
    return {
      data: { start, end },
      selectedText,
      position: { top: anchor.bottom + 8, left: anchor.left },
    };
  }, []);

  const createAnnotation = useCallback(
    (data: ChatAnchor, selectedText: string, comment: string) => {
      onAddAnnotation(data, selectedText, comment);
    },
    [onAddAnnotation],
  );

  // Only listen while this pane is the visible one (the diffs/plans panes stay
  // mounted-but-hidden; we don't want their selections firing here).
  const selection = useCommentSelection<ChatAnchor>({
    enabled: visible,
    resolve: resolveSelection,
    onCreate: createAnnotation,
  });
  const pending = selection.pending;

  const submitEdit = useCallback(
    (comment: string) => {
      if (!editing) return;
      onUpdateAnnotation(editing.annotation.id, comment);
      setEditing(null);
    },
    [editing, onUpdateAnnotation],
  );

  // Stable identities so the memoized part views skip re-rendering.
  const handleClickAnnotation = useCallback(
    (ann: ChatAnnotation, rect: DOMRect) =>
      setEditing({
        annotation: ann,
        pos: { top: rect.bottom + 8, left: rect.left },
      }),
    [],
  );

  // The comment chip's jump. The transcript paints comments with the Custom
  // Highlight API — there's no element to query — so the anchor is rebuilt from
  // the span's own part + offsets, the same way a click resolves it. The part
  // may not be rendered on the frame the tab opens, hence the retry.
  const revealAnnNonce = revealAnnotation?.nonce;
  useEffect(() => {
    if (!revealAnnotation) return;
    const ann = annotations.find((a) => a.id === revealAnnotation.id);
    if (!ann) return;
    // The row is usually outside the render window — the chip opens the tab and
    // asks for the comment in the same breath, so the transcript has just
    // mounted somewhere else entirely. Ask the window to bring that row up;
    // without this the query below never matches and the editor never opens.
    rowWindow.scrollToRow(ann.start.messageUuid);
    let frames = 0;
    let raf = requestAnimationFrame(function find() {
      const part = parentRef.current?.querySelector<HTMLElement>(
        `[data-part-root][data-message-uuid="${CSS.escape(
          ann.start.messageUuid,
        )}"][data-part-index="${ann.start.partIndex}"]`,
      );
      if (part) {
        const sameSpan =
          ann.end.messageUuid === ann.start.messageUuid &&
          ann.end.partIndex === ann.start.partIndex;
        const range = rangeForCover(part, {
          start: ann.start.offset,
          end: sameSpan ? ann.end.offset : null,
        });
        const rect =
          range?.getBoundingClientRect() ?? part.getBoundingClientRect();
        setEditing({
          annotation: ann,
          pos: { top: rect.bottom + 8, left: rect.left },
        });
        return;
      }
      if (frames++ < 90) raf = requestAnimationFrame(find);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAnnNonce]);

  /* ── In-view find (⌘F) ──────────────────────────────────────────────────
   * Searching used to mount every row so it could read the DOM, which left the
   * whole transcript rendered for the entire find session — every keystroke
   * then paid a full style pass (~850ms on 1,792 rows).
   *
   * The chat is indexed ONCE instead, in chunks: a slice of rows is rendered,
   * its real text is read and cached against the message object, the slice is
   * released. Searching runs on that cache and the transcript stays windowed.
   * Text still comes from rendered DOM, so `data-find-skip` and markdown output
   * mean exactly what they did before.
   */
  const rowText = useRef(new WeakMap<object, string>());
  const rowStarts = useRef<number[]>([]);
  const [findText, setFindText] = useState("");
  const [indexCursor, setIndexCursor] = useState(0);

  /** Which row a global offset falls in. */
  const rowOfOffset = useCallback((offset: number) => {
    const st = rowStarts.current;
    let lo = 0;
    let hi = st.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (st[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }, []);

  // Start at the match nearest what the reader is looking at, the way an editor
  // does, instead of jumping to the top of the chat on every keystroke.
  const pickNearest = useCallback((matches: { start: number }[]) => {
    const el = parentRef.current;
    if (!el || matches.length === 0) return 0;
    const rows =
      contentRef.current?.querySelectorAll<HTMLElement>("[data-msg-row]");
    if (!rows || rows.length === 0) return 0;
    const base = contentRef.current?.offsetTop ?? 0;
    const top = el.scrollTop;
    // First row at or below the viewport top, by its real position.
    let lo = 0;
    let hi = rows.length - 1;
    let firstVisible = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].offsetTop - base + rows[mid].offsetHeight > top) {
        firstVisible = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const wantOffset = rowStarts.current[firstVisible] ?? 0;
    const at = matches.findIndex((m) => m.start >= wantOffset);
    return at === -1 ? matches.length - 1 : at;
  }, []);

  const find = useTextFind(findText, pickNearest);
  const [findReveal, setFindReveal] = useState(0);
  const [findPaintNonce, setFindPaintNonce] = useState(0);

  // Small chunks: the cost is rendering each row once, so the total is fixed
  // and the only choice is how much of it lands in a single frame. 60 rows put
  // 299ms in one frame; 12 keeps every frame short enough to stay smooth.
  const INDEX_CHUNK = 12;
  useEffect(() => {
    setFindForceRange(
      indexing
        ? {
            start: indexCursor,
            end: Math.min(indexCursor + INDEX_CHUNK, items.length),
          }
        : null,
    );
  }, [indexing, indexCursor, items.length]);

  const rebuildFindText = useCallback(() => {
    let acc = 0;
    const starts: number[] = [];
    const parts: string[] = [];
    for (const m of items) {
      starts.push(acc);
      const t = rowText.current.get(m) ?? "";
      parts.push(t);
      acc += t.length + 1; // newline separator keeps a match inside one row
    }
    rowStarts.current = starts;
    setFindText(parts.join("\n"));
  }, [items]);

  // Index when find opens, and only the rows not already cached.
  useEffect(() => {
    if (!find.open) {
      setIndexing(false);
      return;
    }
    const firstMissing = items.findIndex((m) => !rowText.current.has(m));
    if (firstMissing === -1) {
      rebuildFindText();
      return;
    }
    setIndexCursor(firstMissing);
    setIndexing(true);
  }, [find.open, items, rebuildFindText]);

  // Harvest the slice that was just rendered, then move on. A layout effect, so
  // a chunk is read before it can be released again.
  useLayoutEffect(() => {
    const range = findForceRange;
    if (!range || !indexing) return;
    const content = contentRef.current;
    if (!content) return;
    const rows = content.querySelectorAll<HTMLElement>("[data-msg-row]");
    for (let i = range.start; i < range.end && i < rows.length; i++) {
      const m = items[i];
      if (!m || rowText.current.has(m)) continue;
      rowText.current.set(m, textOf(rows[i], FIND_SKIP));
    }
    const nextMissing = items.findIndex(
      (m, i) => i >= range.end && !rowText.current.has(m),
    );
    if (range.end >= items.length || nextMissing === -1) {
      setIndexing(false);
      rebuildFindText();
      return;
    }
    const raf = requestAnimationFrame(() => setIndexCursor(nextMissing));
    return () => cancelAnimationFrame(raf);
  }, [findForceRange, indexing, items, rebuildFindText]);

  /** A DOM Range for a match, when its row is rendered. */
  const rangeForMatch = useCallback(
    (m: { start: number; end: number }) => {
      const content = contentRef.current;
      if (!content) return null;
      const row = rowOfOffset(m.start);
      const el = content.querySelectorAll<HTMLElement>("[data-msg-row]")[row];
      if (!el || el.children.length === 0) return null;
      const base = rowStarts.current[row] ?? 0;
      return rangeForOffsets(el, m.start - base, m.end - base, FIND_SKIP);
    },
    [rowOfOffset],
  );

  // Paint the matches near the viewport. Every range added to a Highlight
  // invalidates paint document-wide, so a broad query in a long chat costs
  // milliseconds per match; the count and next/prev still use every match.
  useEffect(() => {
    const hl = getFindHighlights();
    if (!hl) return;
    hl.match.clear();
    hl.current.clear();
    if (!find.open) return;
    const root = parentRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const rows = content.querySelectorAll<HTMLElement>("[data-msg-row]");
    const base = content.offsetTop;
    const top = root.scrollTop - root.clientHeight;
    const bottom = root.scrollTop + 2 * root.clientHeight;
    find.matches.forEach((m, i) => {
      const rowIdx = rowOfOffset(m.start);
      const el = rows[rowIdx];
      if (!el || el.children.length === 0) return;
      const elTop = el.offsetTop - base;
      if (
        i !== find.current &&
        (elTop + el.offsetHeight < top || elTop > bottom)
      )
        return;
      const r = rangeForMatch(m);
      if (r) (i === find.current ? hl.current : hl.match).add(r);
    });
  }, [
    find.open,
    find.matches,
    find.current,
    findText,
    findPaintNonce,
    rowOfOffset,
    rangeForMatch,
  ]);

  // Repaint the band as the reader scrolls, so matches appear as they arrive.
  useEffect(() => {
    const el = parentRef.current;
    if (!el || !find.open) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setFindPaintNonce((n) => n + 1);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [find.open]);

  // Bring the active match into view on NAVIGATION only. Typing reselects the
  // nearest match so the counter reads right, and scrolling on every keystroke
  // is what made the chat jump to another message mid-word.
  const revealedSeq = useRef(0);
  useEffect(() => {
    if (!find.open || find.current < 0 || indexing) return;
    // Only an INCREASE means the reader just pressed next/prev. Comparing
    // against zero replays the previous session's last jump on reopen.
    if (find.navSeq === revealedSeq.current) return;
    revealedSeq.current = find.navSeq;
    const m = find.matches[find.current];
    const root = parentRef.current;
    if (!m || !root) return;
    const rowIdx = rowOfOffset(m.start);
    const message = items[rowIdx] as { uuid?: string } | undefined;
    const uuid = message?.uuid;
    let tries = 0;
    let raf = 0;
    const settle = () => {
      const r = rangeForMatch(m);
      const rect = r?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        const pr = root.getBoundingClientRect();
        if (rect.top < pr.top || rect.bottom > pr.bottom) {
          root.scrollTop += rect.top - pr.top - pr.height / 2 + rect.height / 2;
        }
        setFindPaintNonce((n) => n + 1);
        return;
      }
      if (tries === 0 && uuid) rowWindow.scrollToRow(uuid);
      if (tries++ < 20) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.navSeq, indexing]);

  // Clear the painted highlights when this component unmounts.
  useEffect(() => {
    return () => {
      const hl = getFindHighlights();
      hl?.match.clear();
      hl?.current.clear();
    };
  }, []);

  // ⌘F opens the find widget while this pane is the visible one.
  useEffect(() => {
    if (!visible) return;
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
  }, [visible, find]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No messages
      </div>
    );
  }

  return (
    <SessionCwdContext.Provider value={cwd}>
      <div className="relative h-full">
        {/* Clear of the message rail (28px wide, 12px inset) so neither the
            rail nor the widget has to move when find opens. */}
        <FindWidget
          find={find}
          revealTrigger={findReveal}
          rightPx={48}
          status={
            indexing
              ? `Indexing ${Math.min(99, Math.round((indexCursor / Math.max(1, items.length)) * 100))}%`
              : undefined
          }
        />
        {items.length > 0 && (
          <MessageRail
            messages={items}
            abortedUuids={abortedPrompts}
            scrollRef={parentRef}
            onJump={rowWindow.scrollToRow}
          />
        )}
        <div
          ref={parentRef}
          data-tight-selection
          // overflow-anchor:none — useRowWindow absorbs height changes above the
          // reader itself; Blink correcting the same shift again doubles it.
          className="chat-transcript h-full overflow-auto pt-3 pb-6 [overflow-anchor:none]"
        >
          {/* Reading column (ChatGPT-style): each row centers itself and caps
            its width for readability while the scrollbar stays at the pane edge.
            The cap is per-row (not on this wrapper) so a plan card showing a diff
            can opt out and run full-width, like the diff/file tabs do. */}
          <div ref={contentRef} className="w-full">
            {items.map((m, idx) => {
              const runIndex = toolRuns.runOfRow[idx];
              const run = runIndex >= 0 ? toolRuns.runs[runIndex] : null;
              // Find reads the rendered rows, so it holds every run open for as
              // long as the widget is up — otherwise a search would quietly
              // stop covering the folded parts of the chat.
              const runOpen =
                !run ||
                find.open ||
                openRunKeys.has(run.key) ||
                forcedRunKeys.has(run.key);
              const runCapped =
                !!run && !find.open && !fullRunKeys.has(run.key);
              // A folded row holds no space, so it must not consult the row
              // window: a reserved height is for a row that will render.
              if (
                run &&
                idx !== run.start &&
                (!runOpen || (runCapped && idx > run.peekEnd))
              ) {
                return <div key={m.uuid || idx} data-msg-row={m.uuid} />;
              }
              // Rows far from the viewport render nothing and just hold their
              // place. Building every row's content up front is what froze the
              // click that opens a chat, so nothing above this line may do
              // per-row work.
              if (!rowWindow.shows(idx)) {
                return (
                  <div
                    key={m.uuid || idx}
                    data-msg-row={m.uuid}
                    style={rowWindow.reserve(idx)}
                  />
                );
              }
              if (run && !runOpen) {
                return (
                  <div
                    key={m.uuid || idx}
                    data-msg-row={m.uuid}
                    className="flex w-full justify-center px-4 pt-1 pb-2 scroll-mt-3"
                  >
                    <div className="flex w-full max-w-[820px] justify-start">
                      <ToolRunHeader
                        label={run.label}
                        open={false}
                        onToggle={() => toggleRun(run.key)}
                      />
                    </div>
                  </div>
                );
              }
              const partMap = annotationsByMessage.get(m.uuid);
              const showHeader = showHeaderForRow[idx];
              // A plan card that has a prior version opens on its diff; let that
              // row break out of the reading-width cap so the diff isn't boxed
              // into the narrow column. First-version plans (body only) stay
              // capped like normal messages.
              const rowFullWidth = m.parts.some(
                (_p, i) => (planVersionByPart.get(`${m.uuid}:${i}`) ?? -1) >= 1,
              );
              // iMessage-style: user turns are a right-aligned bubble capped in
              // width; assistant turns run full-width with no bubble. Bash-mode
              // turns read as terminal output, so they go left/full-width too.
              const isUser = isRealUserTurn(m);
              const aborted = isUser && abortedPrompts.has(m.uuid);
              return (
                <div
                  key={m.uuid || idx}
                  data-msg-row={m.uuid}
                  className={cn(
                    // scroll-mt keeps a jumped-to message off the very top edge.
                    "group flex w-full justify-center px-4 scroll-mt-3",
                    showHeader ? "pt-4 pb-2" : "pt-1 pb-2",
                    // Assistant rows: the whole full-width band is a selection
                    // surface (not just the text), so a drag started in the empty
                    // gutter left of the reading column still anchors to the prose
                    // instead of dead-ending on the `user-select:none` scroller —
                    // you don't have to start exactly on the text. The inner
                    // column below keeps the reading width centered.
                    !isUser && "select-text",
                  )}
                >
                  <div
                    className={cn(
                      "flex w-full",
                      rowFullWidth ? "max-w-none" : "max-w-[820px]",
                      isUser ? "justify-end" : "justify-start",
                    )}
                  >
                    {(() => {
                      const partNodes = m.parts.map((p, i) => {
                        const partKey = `${m.uuid}:${i}`;
                        // Edit/MultiEdit/ExitPlanMode parts the plan card subsumes.
                        if (hiddenParts.has(partKey)) return null;
                        // tool_result renders inline within its tool_use; an empty
                        // wrapper here would add a stray flex gap.
                        if (p.kind === "tool_result") return null;
                        const planVersionIndex =
                          planVersionByPart.get(partKey) ?? -1;
                        return (
                          <PartView
                            key={i}
                            messageUuid={m.uuid}
                            partIndex={i}
                            partAnns={partMap?.get(i) ?? EMPTY_PART_ANNS}
                            repaintNonce={repaintNonce}
                            pendingCover={
                              pending
                                ? coverForSpanPart(
                                    pending.data.start,
                                    pending.data.end,
                                    m.uuid,
                                    i,
                                    partOrder,
                                  )
                                : null
                            }
                            onClickAnnotation={handleClickAnnotation}
                            part={p}
                            message={m}
                            result={
                              p.kind === "tool_use"
                                ? resultByToolUseId.get(p.id)
                                : undefined
                            }
                            terminalReady={terminalReady}
                            onSendKeys={onSendKeys}
                            planVersions={
                              planVersionIndex >= 0
                                ? planVersions
                                : EMPTY_PLAN_VERSIONS
                            }
                            planVersionIndex={planVersionIndex}
                            encoded={encoded}
                          />
                        );
                      });
                      if (!isUser) {
                        return (
                          <div className="flex w-full flex-col gap-1">
                            {run && idx === run.start && (
                              <ToolRunHeader
                                label={run.label}
                                open
                                onToggle={() => toggleRun(run.key)}
                              />
                            )}
                            <div className="flex w-full flex-col gap-1.5">
                              {partNodes}
                            </div>
                            {run &&
                              runCapped &&
                              idx === run.peekEnd &&
                              run.peekEnd < run.end && (
                                <ToolRunMore
                                  hidden={run.end - run.peekEnd}
                                  onShowAll={() => showWholeRun(run.key)}
                                />
                              )}
                            {turnFilesByRow.has(idx) && (
                              <TurnFilesStrip
                                files={turnFilesByRow.get(idx)!}
                                encoded={encoded}
                                cwd={cwd}
                              />
                            )}
                            {/* Meta row (reply time + copy) shows on ONLY the
                          last row of the newest assistant turn, and only once
                          the reply has finished (`!working`) — so it marks the
                          end of the latest response instead of trailing every
                          turn or flashing mid-stream. */}
                            {idx === replyMeta?.idx && !working && (
                              <div className="flex items-center gap-[7px] pl-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                <TimeAgo
                                  ts={m.timestamp}
                                  variant="message"
                                  className="text-[11px] text-[var(--text-tertiary)]"
                                />
                                <CopyButton getText={() => replyMeta.text} />
                              </div>
                            )}
                          </div>
                        );
                      }
                      const imageOnly = isImageOnlyMessage(m);
                      return (
                        <div className="flex max-w-[80%] flex-col items-end gap-1">
                          {/* An abandoned prompt keeps its bubble — you did type
                          it — but drops the fill for a dashed edge, so it reads
                          as a draft that never left. */}
                          <div
                            className={cn(
                              "flex gap-1.5",
                              aborted && "opacity-55",
                              imageOnly
                                ? // Attachments carry their own edges: no bubble
                                  // to draw a second border inside them, and they
                                  // wrap sideways instead of stacking.
                                  "w-fit flex-wrap justify-end"
                                : [
                                    "w-full flex-col rounded-2xl rounded-br-sm border border-[var(--border)] px-3.5 py-2",
                                    aborted
                                      ? "border-dashed bg-transparent"
                                      : "bg-[var(--bg-surface)]",
                                  ],
                            )}
                            style={
                              imageOnly
                                ? { maxWidth: IMAGE_GRID_MAX_W }
                                : undefined
                            }
                          >
                            {imageOnly ? (
                              partNodes
                            ) : (
                              <CollapsibleUserMessage>
                                {partNodes}
                              </CollapsibleUserMessage>
                            )}
                          </div>
                          {/* Meta row sits outside the bubble, bottom-right, and
                          waits for a hover — except on an abandoned prompt,
                          where "Not sent" is the whole point. */}
                          <div
                            className={cn(
                              "flex items-center gap-[7px] pr-0.5 transition-opacity",
                              !aborted &&
                                "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                            )}
                          >
                            {aborted && (
                              <span
                                className="text-[11px] text-[var(--text-tertiary)]"
                                title="You interrupted this before it reached Claude, so it was never part of the conversation."
                              >
                                Not sent
                              </span>
                            )}
                            <TimeAgo
                              ts={m.timestamp}
                              variant="message"
                              className="text-[11px] text-[var(--text-tertiary)]"
                            />
                            <CopyButton getText={() => messageText(m)} />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
            {working && (
              // Mirror a message row's layout (px-4 band + centered 820 column)
              // so the pill's left edge lands on the same column edge as the
              // prose and "Ran …" rows above it, at every viewport width.
              <div className="flex w-full justify-center px-4">
                <div className="w-full max-w-[820px]">
                  <TypingIndicator />
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Blur-fade where messages scroll up under the composer. Deliberately
          faint — a thin strip with a light blur that the mask ramps out to
          nothing, so the last line dissolves instead of sitting under a fog
          band. pointer-events-none so it never blocks scrolling/selection. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 backdrop-blur-[1px]"
          style={{
            background: "linear-gradient(to top, var(--bg), transparent)",
            WebkitMaskImage: "linear-gradient(to top, black, transparent)",
            maskImage: "linear-gradient(to top, black, transparent)",
          }}
        />
        {showScrollDown && (
          <button
            onClick={scrollToBottom}
            title="Scroll to latest"
            aria-label="Scroll to latest"
            className="absolute bottom-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-lg transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {pending && (
        <CommentPopover
          position={pending.position}
          selectedText={pending.selectedText}
          context={chatContext(messages, pending.data.start.messageUuid)}
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
            onRemoveAnnotation(editing.annotation.id);
            setEditing(null);
          }}
        />
      )}
    </SessionCwdContext.Provider>
  );
});

/**
 * iMessage-style "Claude is working" typing bubble shown below the last message.
 * Three dots bouncing on staggered delays. No text nodes, so it doesn't disturb
 * the transcript's offset space (annotations / ⌘F find).
 */
function TypingIndicator() {
  return (
    <div className="pt-1 pb-2" aria-label="Claude is working">
      <div className="inline-flex items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-tertiary)]"
            style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
          />
        ))}
      </div>
    </div>
  );
}

/** Read a part wrapper's `data-part-index` as a number (0 if missing). */
function partIndexOf(el: HTMLElement): number {
  return parseInt(el.getAttribute("data-part-index") ?? "0", 10);
}

/** Read a part wrapper's owning message uuid (`data-message-uuid`). */
function msgUuidOf(el: HTMLElement): string {
  return el.getAttribute("data-message-uuid") ?? "";
}
