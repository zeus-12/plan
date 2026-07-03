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
import { Check, ChevronDown, Copy } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import { useCommentSelection } from "@plan/shared/lib/use-comment-selection";
import { useTextFind } from "@plan/shared/lib/use-text-find";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { FindWidget } from "@plan/shared/components/find-widget";
import { Markdown } from "@plan/shared/components/markdown";
import { AskQuestionCard, parseAskInput } from "./ask-question-card";
import { PlanCard, parsePlanInput, type PlanVersionInfo } from "./plan-card";
import { ImageLightbox } from "./image-lightbox";
import { UserMessageOverview } from "./user-message-overview";
import type { ConversationMessage, MessagePart } from "../../shared-types";

/** How far (px) above the bottom the user must scroll before the "jump to
 *  latest" button appears. */
const SCROLL_DOWN_THRESHOLD_PX = 400;

type MessageCategory = "user-real" | "tool" | "assistant";

function classify(m: ConversationMessage): MessageCategory {
  if (m.role === "assistant") return "assistant";
  const hasNonToolResult = m.parts.some((p) => p.kind !== "tool_result");
  return hasNonToolResult ? "user-real" : "tool";
}

/**
 * A "!" bash-mode turn (command or its output) — its parts are all bash-tagged
 * text. Rendered left-aligned and full-width like terminal output, not in the
 * right-hand user bubble. (parseBashBlock is hoisted.)
 */
function isBashMessage(m: ConversationMessage): boolean {
  return (
    m.parts.length > 0 &&
    m.parts.every((p) => p.kind === "text" && parseBashBlock(p.text) !== null)
  );
}

/**
 * A background-task notification turn (system-injected, not real user input) —
 * rendered full-width as a status card, not in the right-hand user bubble.
 */
function isTaskNotificationMessage(m: ConversationMessage): boolean {
  return (
    m.parts.length > 0 &&
    m.parts.every(
      (p) => p.kind === "text" && parseTaskNotifications(p.text) !== null,
    )
  );
}

/**
 * A harness-injected turn (skill body, loop tick, context caveat) flagged by
 * metadata. Rendered full-width as a muted, collapsible system card, not in the
 * user bubble. Image-only meta turns are left alone — they render as images.
 */
function isSystemMetaMessage(m: ConversationMessage): boolean {
  if (m.role !== "user") return false;
  if (m.isMeta !== true && m.promptSource !== "system") return false;
  return !m.parts.every(
    (p) => p.kind === "text" && imageOnlyPaths(p.text) !== null,
  );
}

/** One endpoint of a chat selection: which message, which part of that turn, and
 *  the char offset into that part's annotatable text (see `annoTextWalker`). */
export interface ChatSpan {
  messageUuid: string;
  partIndex: number;
  offset: number;
}

/** A chat comment anchored to a document-order span from `start` to `end`, which
 *  may cross several parts AND several message rows (prose + the tool rows and
 *  turns between them). */
export interface ChatAnnotation {
  id: string;
  start: ChatSpan;
  end: ChatSpan;
  selectedText: string;
  comment: string;
}

interface Props {
  messages: ConversationMessage[];
  /** Project key — lets plan cards reach the shared annotation store for
   *  diff comments (keyed there by the plan file path). */
  encoded: string;
  annotations: ChatAnnotation[];
  onAddAnnotation: (
    anchor: ChatAnchor,
    selectedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
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

/** Surface-specific anchor for a chat comment: a document-order span from `start`
 *  to `end`, which may cross parts and message rows. */
export interface ChatAnchor {
  start: ChatSpan;
  end: ChatSpan;
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

const POPOVER_VIEWPORT_PAD = 380;

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

// ── Plan-file detection ─────────────────────────────────────────────
// Claude presents a plan by writing it to ~/.claude/plans/<slug>.md (a real
// Write tool call that executes — and lands in the transcript — immediately),
// then calls ExitPlanMode. ExitPlanMode is gated behind the user's approval, so
// its content shows up late/empty; the Write does NOT. So we source the inline
// plan card from the plan file's Write/Edit ops, reconstructed from the
// transcript, and hide the gated ExitPlanMode block entirely.
const PLANS_PATH_MARKER = "/.claude/plans/";

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The plans-dir path a Write/Edit/MultiEdit targets, or null if not one. */
function planFilePath(p: MessagePart): string | null {
  if (p.kind !== "tool_use") return null;
  if (p.tool !== "Write" && p.tool !== "Edit" && p.tool !== "MultiEdit")
    return null;
  const fp = (p.input as { file_path?: unknown } | null)?.file_path;
  return typeof fp === "string" && fp.includes(PLANS_PATH_MARKER) ? fp : null;
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
 * Disclosure block whose body animates open/closed via a grid-rows transition —
 * smooth, with no layout shift and no max-height guessing.
 */
function CollapsibleBlock({
  label,
  preview,
  children,
  /** Exclude the preview + body from ⌘F find (bulky tool args/output); the
   *  label (e.g. the tool name) stays searchable. */
  skipFindContent = false,
}: {
  label: string;
  preview: string;
  children: React.ReactNode;
  skipFindContent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
      <button
        onClick={toggleUnlessSelecting(() => setOpen((v) => !v))}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
      >
        <span
          className={cn(
            "inline-block text-[9px] transition-transform duration-200",
            open && "rotate-90",
          )}
        >
          ▶
        </span>
        <span className="shrink-0 whitespace-nowrap text-[var(--text-secondary)]">
          {label}
        </span>
        {!open && preview && (
          <span
            className="min-w-0 truncate text-[var(--text-tertiary)]"
            data-find-skip={skipFindContent ? "" : undefined}
          >
            {preview}
          </span>
        )}
      </button>
      {/* The raw body is excluded from comment text (data-anno-skip): a comment
          spanning this block captures its summary line, not the dump inside. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        data-find-skip={skipFindContent ? "" : undefined}
        data-anno-skip=""
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/** Plain text a user turn copies to the clipboard — its text parts joined. */
function userMessageText(m: ConversationMessage): string {
  return m.parts
    .filter(
      (p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text",
    )
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

/**
 * 12-hour clock time with AM/PM in the viewer's local timezone, e.g. "2:45 PM".
 * The stored timestamp is UTC ISO; toLocaleTimeString converts it to local.
 * Empty on an unparseable ts.
 */
function formatClockTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** How tall (px) a user bubble grows before it clips behind a "Show more". */
const USER_MESSAGE_MAX_H = 260;

/**
 * User-bubble body that clips past a max height and reveals a bottom-left
 * "Show more" toggle. Overflow is measured off the content's scrollHeight (the
 * full, un-clamped height), so the toggle stays correct in both states.
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

  return (
    <>
      <div
        ref={ref}
        className="flex flex-col gap-1.5 overflow-hidden"
        style={{ maxHeight: expanded ? undefined : USER_MESSAGE_MAX_H }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          onClick={toggleUnlessSelecting(() => setExpanded((v) => !v))}
          className="mt-px flex items-center gap-0.5 self-start text-[11px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDown
            size={12}
            className={cn("transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
    </>
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

function ChevronRight({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0 text-[var(--text-tertiary)] transition-transform duration-200",
        open && "rotate-90",
      )}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/** The basename of a path (last segment), for compact tool-call headers. */
function baseName(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
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
      return { verb: "Read", target: fp ? baseName(fp) : "" };
    case "Edit":
    case "MultiEdit":
      return { verb: "Edit", target: fp ? baseName(fp) : "" };
    case "Write":
      return { verb: "Write", target: fp ? baseName(fp) : "" };
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
            {/* Explicit space so a comment spanning this row reads "Ran <target>",
                not "Ran<target>" — flex collapses it visually, textContent keeps it. */}{" "}
            {target}
          </span>
        )}
        <ChevronRight open={open} />
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
                <CodeBody text={result.output} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Monospace, scrollable code body used inside disclosure blocks. */
function CodeBody({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-[400px] select-text overflow-auto whitespace-pre-wrap break-all font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)] [cursor:text]",
        className,
      )}
    >
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

interface FindSeg {
  node: Text;
  start: number;
}

/**
 * Walk `root` collecting searchable text + the text-node segments it came from,
 * skipping any subtree marked `data-find-skip` (tool-call args/output — bulky and
 * not worth searching; the tool name in the header stays searchable). The
 * returned `segs` let a match offset map back to a DOM Range without re-walking.
 */
function collectFindable(root: HTMLElement): { text: string; segs: FindSeg[] } {
  const segs: FindSeg[] = [];
  let text = "";
  const walk = (el: Node) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        segs.push({ node: n as Text, start: text.length });
        text += (n as Text).data;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        if ((n as Element).hasAttribute("data-find-skip")) continue;
        walk(n);
      }
    }
  };
  walk(root);
  return { text, segs };
}

/** Build a DOM Range for [start, end) over collected segments. */
function rangeFromSegs(
  segs: FindSeg[],
  start: number,
  end: number,
): Range | null {
  if (segs.length === 0 || end <= start) return null;
  const seg = (off: number) => {
    let lo = 0;
    let hi = segs.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= off) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return segs[ans];
  };
  const a = seg(start);
  const b = seg(end - 1);
  const r = document.createRange();
  try {
    r.setStart(a.node, Math.min(start - a.start, a.node.data.length));
    r.setEnd(b.node, Math.min(end - b.start, b.node.data.length));
  } catch {
    return null;
  }
  return r;
}

/**
 * Text-node walker over a part's *annotatable* text — the visible prose and
 * tool-summary lines — skipping any `[data-anno-skip]` subtree (collapsible raw
 * bodies, plan-card chrome, the in-card diff). This one character-offset space
 * is shared by selection capture, highlight painting, and click hit-testing, so
 * a comment never swallows a collapsed block's hidden dump.
 */
function annoTextWalker(root: HTMLElement): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (
        let el = node.parentElement;
        el && el !== root;
        el = el.parentElement
      ) {
        if (el.hasAttribute("data-anno-skip")) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

/** The concatenated annotatable text of `root` (see {@link annoTextWalker}). */
function annoText(root: HTMLElement): string {
  const walker = annoTextWalker(root);
  let s = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    s += n.textContent ?? "";
  return s;
}

/** Build a DOM Range for [start, end) character offsets into `root`'s text. */
function rangeForOffsets(
  root: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const walker = annoTextWalker(root);
  let acc = 0;
  let startNode: Node | null = null;
  let startNodeOff = 0;
  let endNode: Node | null = null;
  let endNodeOff = 0;
  let n = walker.nextNode();
  while (n) {
    const len = n.textContent?.length ?? 0;
    if (startNode === null && acc + len > start) {
      startNode = n;
      startNodeOff = start - acc;
    }
    if (acc + len >= end) {
      endNode = n;
      endNodeOff = end - acc;
      break;
    }
    acc += len;
    n = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, startNodeOff);
    range.setEnd(endNode, endNodeOff);
  } catch {
    return null;
  }
  return range;
}

/** DOM Range for the covered region of a part. An open-ended cover (`end: null`)
 *  extends to the current end of the part's annotatable text — recomputed each
 *  paint, so it re-anchors when a block expands. */
function rangeForCover(root: HTMLElement, cover: PartCover): Range | null {
  const end = cover.end ?? annoText(root).length;
  if (end <= cover.start) return null;
  return rangeForOffsets(root, cover.start, end);
}

/**
 * A markdown-rendered message text part. Selection highlights, click-to-edit and
 * part addressing all live on the shared {@link PartWrapper} now, so this is just
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

/**
 * Wraps every message part with the machinery that makes it commentable: a
 * selectable host tagged with its (message, part) coordinates, the custom
 * highlights for annotations covering this part plus the in-flight pending
 * selection, and click-to-edit hit-testing. Applying this uniformly to text AND
 * tool blocks is what lets a selection — and its comment — span the tool rows
 * ("Ran …/filename") that sit between two paragraphs.
 */
function PartWrapper({
  messageUuid,
  partIndex,
  partAnns,
  pendingCover,
  onClickAnnotation,
  children,
}: {
  messageUuid: string;
  partIndex: number;
  partAnns: PartAnn[];
  pendingCover: PartCover | null;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Repaint when the covered ranges change AND whenever the part resizes: an
  // open-ended cover ("to end of part") must re-anchor when a tool block expands
  // or markdown reflows.
  useLayoutEffect(() => {
    const root = ref.current;
    const hl = getHighlights();
    if (!root || !hl) return;
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
    const ro = new ResizeObserver(() => {
      clear();
      paint();
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [partAnns, pendingCover]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (partAnns.length === 0) return;
      const root = ref.current;
      if (!root) return;
      const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!caret) return;
      const off = offsetWithin(root, caret.startContainer, caret.startOffset);
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
      {children}
    </div>
  );
}

interface ToolResult {
  output: string;
  isError?: boolean;
}

// Claude Code records a pasted image as a standalone message whose text is just
// "[Image: source: <path>]". Render those straight from the file on disk via a
// file:// URL — no copy, no base64, no bytes through JS.
function imageOnlyPaths(text: string): string[] | null {
  const re = /\[Image: source:\s*(.+?)\s*\]/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) paths.push(m[1]);
  if (paths.length === 0) return null;
  // Only treat the message as an image if that's ALL it contains.
  const remainder = text.replace(/\[Image: source:\s*(.+?)\s*\]/g, "").trim();
  return remainder.length === 0 ? paths : null;
}

function mediaUrl(path: string): string {
  // Absolute local path → file:// URL (encodeURI keeps the slashes, escapes
  // spaces in names like ".../CleanShot 2026 ….png").
  return `file://${encodeURI(path)}`;
}

function TranscriptImage({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  if (failed) {
    return (
      <div className="my-1 rounded-md border border-dashed border-[var(--border)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        Image unavailable
        <div className="truncate text-[var(--text-tertiary)]">{path}</div>
      </div>
    );
  }
  const src = mediaUrl(path);
  return (
    <>
      <img
        src={src}
        alt="Attached image"
        onError={() => setFailed(true)}
        onClick={() => setPreview(true)}
        className="my-1 max-h-[340px] max-w-full cursor-zoom-in rounded-md border border-[var(--border)] object-contain"
      />
      {preview && <ImageLightbox src={src} onClose={() => setPreview(false)} />}
    </>
  );
}

/**
 * Claude Code records a "!" bash-mode turn as tagged text:
 *   <bash-input>cmd</bash-input>                                  the command
 *   <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>      its output
 * Detect those so we can render a terminal block instead of leaking raw tags.
 */
function parseBashBlock(text: string): {
  input: string | null;
  stdout: string | null;
  stderr: string | null;
} | null {
  const t = text.trim();
  if (!/^<bash-(input|stdout|stderr)>/.test(t)) return null;
  const grab = (tag: string) => {
    const m = t.match(new RegExp(`<bash-${tag}>([\\s\\S]*?)</bash-${tag}>`));
    return m ? m[1] : null;
  };
  const input = grab("input");
  const stdout = grab("stdout");
  const stderr = grab("stderr");
  if (input === null && stdout === null && stderr === null) return null;
  return { input, stdout, stderr };
}

/**
 * Claude Code injects a background-task completion as a user turn whose text is
 * a raw `<task-notification>` block:
 *   <task-notification>
 *     <task-id>…</task-id><tool-use-id>…</tool-use-id>
 *     <output-file>…</output-file><status>completed</status>
 *     <summary>Background command "…" completed (exit code 0)</summary>
 *   </task-notification>
 * Parse those out (a turn may carry several) so we render a tidy status card
 * instead of leaking the angle-bracket soup. `remainder` is any surrounding
 * prose, rendered as normal markdown.
 */
interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  outputFile: string | null;
  status: string | null;
  summary: string | null;
}

function parseTaskNotifications(
  text: string,
): { notifications: TaskNotification[]; remainder: string } | null {
  if (!text.includes("<task-notification>")) return null;
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  const notifications: TaskNotification[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const grab = (tag: string) => {
      const mm = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return mm ? mm[1].trim() : null;
    };
    notifications.push({
      taskId: grab("task-id"),
      toolUseId: grab("tool-use-id"),
      outputFile: grab("output-file"),
      status: grab("status"),
      summary: grab("summary"),
    });
  }
  if (notifications.length === 0) return null;
  const remainder = text.replace(re, "").trim();
  return { notifications, remainder };
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
        <ChevronRight open={open} />
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
        <ChevronRight open={open} />
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

/** Memoized: a keystroke elsewhere must not re-render every markdown block. */
const MessagePartView = memo(
  function MessagePartView({
    part,
    message,
    result,
    terminalReady,
    onSendKeys,
    planVersions,
    planVersionIndex,
    encoded,
  }: MessagePartViewProps) {
    switch (part.kind) {
      case "text": {
        const imgPaths = imageOnlyPaths(part.text);
        if (imgPaths) {
          return (
            <div className="flex flex-col gap-2">
              {imgPaths.map((p, i) => (
                <TranscriptImage key={`${i}:${p}`} path={p} />
              ))}
            </div>
          );
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
        if (message.isMeta || message.promptSource === "system") {
          return <SystemMetaBlock text={part.text} />;
        }
        return <MarkdownText text={part.text} />;
      }
      case "thinking":
        return (
          <CollapsibleBlock
            label="💭 Thinking"
            preview={truncate(part.text, 120)}
          >
            <CodeBody text={part.text} className="px-3 pb-3" />
          </CollapsibleBlock>
        );
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
  },
  // Message/part objects keep their identity across session refreshes (see
  // mergeSession), so reference checks suffice — except the paired tool result,
  // which is rebuilt each parse and is compared by content.
  (prev, next) =>
    prev.part === next.part &&
    prev.message === next.message &&
    prev.terminalReady === next.terminalReady &&
    prev.onSendKeys === next.onSendKeys &&
    prev.planVersions === next.planVersions &&
    prev.planVersionIndex === next.planVersionIndex &&
    prev.encoded === next.encoded &&
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

/**
 * Memoized: the composer's state lives in the workspace, so without this every
 * keystroke would re-render the entire (non-virtualized) transcript.
 */
export const MessageList = memo(function MessageList({
  messages,
  encoded,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
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
  // → its head). Each PartWrapper then paints its own slice.
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

  /** Per-row "should we show the role header here?" */
  const showHeaderForRow = useMemo(() => {
    const out: boolean[] = [];
    let prevCat: MessageCategory | null = null;
    for (const m of items) {
      const cat = classify(m);
      // Tool-result rows never show a header (they belong to the previous turn)
      if (cat === "tool") {
        out.push(false);
      } else {
        out.push(cat !== prevCat);
      }
      prevCat = cat;
    }
    return out;
  }, [items]);

  // Not virtualized: chat sessions are bounded, and virtualization with
  // dynamic (markdown) heights re-measures rows above the viewport, which
  // shifts the scroll position — the "jumps as you scroll up" glitch. Natural
  // flow keeps the scroll perfectly stable.
  const sessionAnchorKey = items[0]?.uuid ?? `len-${items.length}`;
  const sessionKeyRef = useRef<string | null>(null);
  const followingBottomRef = useRef(true);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    // Reset to "following" on session change so a freshly-opened chat anchors
    // to the latest message.
    if (sessionKeyRef.current !== sessionAnchorKey) {
      sessionKeyRef.current = sessionAnchorKey;
      followingBottomRef.current = true;
    }
    if (followingBottomRef.current) el.scrollTop = el.scrollHeight;
    // `working` is a dep so the typing indicator appearing/disappearing keeps us
    // anchored to the bottom when following.
  }, [sessionAnchorKey, items.length, deferredMessages, working]);

  // Becoming visible again (pane was display:none): layout was skipped while
  // hidden, so re-anchor to the bottom if we were following it.
  useLayoutEffect(() => {
    if (!visible) return;
    const el = parentRef.current;
    if (el && followingBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  // Show a "jump to latest" button once the user scrolls a screenful-ish up.
  const [showScrollDown, setShowScrollDown] = useState(false);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      followingBottomRef.current = distance < 20;
      setShowScrollDown(distance > SCROLL_DOWN_THRESHOLD_PX);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [items.length]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
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
    const firstOffs = selectedOffsetsWithin(firstEl, range);
    if (!firstOffs) return null;
    const lastOffs =
      firstEl === lastEl ? firstOffs : selectedOffsetsWithin(lastEl, range);

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
    // way down. Clamp into the viewport so it's always reachable.
    const anchor = lastLineRect(range);
    return {
      data: { start, end },
      selectedText,
      position: {
        top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - 260)),
        left: Math.max(
          8,
          Math.min(anchor.left, window.innerWidth - POPOVER_VIEWPORT_PAD),
        ),
      },
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
        pos: {
          top: rect.bottom + 8,
          left: Math.max(
            8,
            Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD),
          ),
        },
      }),
    [],
  );

  /* ── In-view find (⌘F) ──────────────────────────────────────── */

  // The transcript is plain rendered DOM (not virtualized), so we search the
  // concatenated visible text and paint matches with the CSS Custom Highlight
  // API — no DOM splitting, every match found.
  const [findDomText, setFindDomText] = useState("");
  const find = useTextFind(findDomText);
  const [findReveal, setFindReveal] = useState(0);
  // Text-node segments captured alongside `findDomText`, so a match offset maps
  // back to a DOM Range (and tool-call args excluded via `data-find-skip`).
  const findSegsRef = useRef<FindSeg[]>([]);

  // (Re)snapshot the transcript text whenever find is open and the content
  // settles, so offsets line up with what's currently on screen. The snapshot
  // walks every text node — O(DOM size) — so we DON'T run it synchronously on
  // the keypress that opens find (that was the lag on long transcripts), and we
  // coalesce re-walks while a session streams. A short debounce both defers the
  // first walk off the open frame and collapses a burst of streaming updates
  // into one rebuild; transcript updates land ~quarter-second apart, so it
  // settles between them rather than starving.
  useEffect(() => {
    if (!find.open) {
      setFindDomText("");
      findSegsRef.current = [];
      return;
    }
    const id = setTimeout(() => {
      const el = parentRef.current;
      if (!el) return;
      const { text, segs } = collectFindable(el);
      findSegsRef.current = segs;
      setFindDomText(text);
    }, 120);
    return () => clearTimeout(id);
  }, [find.open, items, deferredMessages]);

  // Paint all matches; the active one gets the stronger highlight.
  useEffect(() => {
    const hl = getFindHighlights();
    if (!hl) return;
    hl.match.clear();
    hl.current.clear();
    if (!find.open) return;
    find.matches.forEach((m, i) => {
      const r = rangeFromSegs(findSegsRef.current, m.start, m.end);
      if (r) (i === find.current ? hl.current : hl.match).add(r);
    });
  }, [find.open, find.matches, find.current, findDomText]);

  // Center the active match in the viewport as the user steps through.
  useEffect(() => {
    if (!find.open || find.current < 0) return;
    const root = parentRef.current;
    const m = find.matches[find.current];
    if (!root || !m) return;
    const r = rangeFromSegs(findSegsRef.current, m.start, m.end);
    const rect = r?.getBoundingClientRect();
    if (!rect) return;
    const pr = root.getBoundingClientRect();
    if (rect.top < pr.top || rect.bottom > pr.bottom) {
      root.scrollTop += rect.top - pr.top - pr.height / 2 + rect.height / 2;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.current, find.matches]);

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
    <>
      <div className="relative h-full">
        <FindWidget find={find} revealTrigger={findReveal} />
        {!find.open && (
          <UserMessageOverview messages={items} scrollRef={parentRef} />
        )}
        <div ref={parentRef} className="h-full overflow-auto pt-3 pb-6">
          {/* Centered reading column (ChatGPT-style): the scrollbar stays at the
            pane edge while message width is capped for readability. Diff/file
            tabs are separate views and keep their full width. */}
          <div className="mx-auto w-full max-w-[820px]">
            {items.map((m, idx) => {
              const partMap = annotationsByMessage.get(m.uuid);
              const showHeader = showHeaderForRow[idx];
              // iMessage-style: user turns are a right-aligned bubble capped in
              // width; assistant turns run full-width with no bubble. Bash-mode
              // turns read as terminal output, so they go left/full-width too.
              const isUser =
                !isBashMessage(m) &&
                !isTaskNotificationMessage(m) &&
                !isSystemMetaMessage(m) &&
                classify(m) === "user-real";
              return (
                <div
                  key={m.uuid || idx}
                  data-msg-row={m.uuid}
                  className={cn(
                    // content-visibility lets the browser skip layout/paint of
                    // off-screen rows — width changes (sidebar toggles) would
                    // otherwise reflow the entire transcript.
                    // scroll-mt keeps a jumped-to message off the very top edge.
                    "group flex px-4 scroll-mt-3 [content-visibility:auto] [contain-intrinsic-block-size:auto_140px]",
                    showHeader ? "pt-4 pb-2" : "pt-1 pb-2",
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
                        <PartWrapper
                          key={i}
                          messageUuid={m.uuid}
                          partIndex={i}
                          partAnns={partMap?.get(i) ?? EMPTY_PART_ANNS}
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
                        >
                          <MessagePartView
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
                        </PartWrapper>
                      );
                    });
                    if (!isUser) {
                      return (
                        <div className="flex w-full flex-col gap-1.5">
                          {partNodes}
                        </div>
                      );
                    }
                    const time = formatClockTime(m.timestamp);
                    return (
                      <div className="flex max-w-[80%] flex-col items-end gap-1">
                        <div className="flex w-full flex-col gap-1.5 rounded-2xl rounded-br-sm border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-2">
                          <CollapsibleUserMessage>
                            {partNodes}
                          </CollapsibleUserMessage>
                        </div>
                        {/* Meta row sits outside the bubble, bottom-right: the send
                        time, then a small gap, then a copy button. Hidden until
                        the message row is hovered or focused. */}
                        <div className="flex items-center gap-[7px] pr-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          {time && (
                            <span className="text-[11px] text-[var(--text-tertiary)]">
                              {time}
                            </span>
                          )}
                          <CopyButton getText={() => userMessageText(m)} />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            {working && <TypingIndicator />}
          </div>
        </div>
        {/* Soft blur-fade where messages scroll up under the composer — the
          bottom rows dissolve into the background instead of cutting off hard.
          pointer-events-none so it never blocks scrolling/selection. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 backdrop-blur-[2px]"
          style={{
            background: "linear-gradient(to top, var(--bg) 20%, transparent)",
            WebkitMaskImage: "linear-gradient(to top, black 40%, transparent)",
            maskImage: "linear-gradient(to top, black 40%, transparent)",
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
    </>
  );
});

/**
 * iMessage-style "Claude is working" typing bubble shown below the last message.
 * Three dots bouncing on staggered delays. No text nodes, so it doesn't disturb
 * the transcript's offset space (annotations / ⌘F find).
 */
function TypingIndicator() {
  return (
    <div className="px-4 pt-1 pb-2" aria-label="Claude is working">
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

/**
 * The rect of a selection's last visible line — the last of `getClientRects()`
 * with real area. `getBoundingClientRect()` unions in a zero-size rect at the
 * range's end boundary, which for a tall multi-line selection can sit far below
 * the last line and mis-place anything anchored to it.
 */
function lastLineRect(range: Range): DOMRect {
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  return rects[rects.length - 1] ?? range.getBoundingClientRect();
}

/** Read a part wrapper's `data-part-index` as a number (0 if missing). */
function partIndexOf(el: HTMLElement): number {
  return parseInt(el.getAttribute("data-part-index") ?? "0", 10);
}

/** Read a part wrapper's owning message uuid (`data-message-uuid`). */
function msgUuidOf(el: HTMLElement): string {
  return el.getAttribute("data-message-uuid") ?? "";
}

function ancestorWithAttr(node: Node, attr: string): HTMLElement | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : node.parentElement;
  while (el) {
    if (el.hasAttribute(attr)) return el;
    el = el.parentElement;
  }
  return null;
}

function offsetWithin(root: HTMLElement, node: Node, nodeOff: number): number {
  const walker = annoTextWalker(root);
  let acc = 0;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    if (cur === node) return acc + nodeOff;
    acc += cur.textContent?.length ?? 0;
    cur = walker.nextNode();
  }
  return -1;
}

/**
 * Character offsets [start, end) of the part of `range` that lies inside `root`,
 * in the same text-content space as {@link rangeForOffsets} / `offsetWithin`.
 *
 * Walks `root`'s text nodes and keeps only the portion each one contributes to
 * the selection, so endpoints that fall outside `root` (or on element nodes, as
 * a triple-click's end boundary does) are clamped to what's actually covered
 * rather than to the whole part. Returns null if the range covers no text here.
 */
function selectedOffsetsWithin(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  const walker = annoTextWalker(root);
  let acc = 0;
  let start = -1;
  let end = -1;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const len = cur.textContent?.length ?? 0;
    if (len > 0 && range.intersectsNode(cur)) {
      const localStart = cur === range.startContainer ? range.startOffset : 0;
      const localEnd = cur === range.endContainer ? range.endOffset : len;
      // Skip a node the range only touches at a boundary (no chars covered).
      if (localStart < localEnd) {
        if (start === -1) start = acc + localStart;
        end = acc + localEnd;
      }
    }
    acc += len;
    cur = walker.nextNode();
  }
  return start === -1 ? null : { start, end };
}
