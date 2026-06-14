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
import { cn } from "@plan/shared/lib/utils";
import { useCommentSelection } from "@plan/shared/lib/use-comment-selection";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { Markdown } from "@plan/shared/components/markdown";
import { AskQuestionCard, parseAskInput } from "./ask-question-card";
import { PlanCard, parsePlanInput, type PlanVersionInfo } from "./plan-card";
import { ImageLightbox } from "./image-lightbox";
import type {
  ConversationMessage,
  MessagePart,
} from "../../shared-types";

type MessageCategory = "user-real" | "tool" | "assistant";

function classify(m: ConversationMessage): MessageCategory {
  if (m.role === "assistant") return "assistant";
  const hasNonToolResult = m.parts.some((p) => p.kind !== "tool_result");
  return hasNonToolResult ? "user-real" : "tool";
}

export interface ChatAnnotation {
  id: string;
  messageUuid: string;
  partIndex: number;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  comment: string;
}

interface Props {
  messages: ConversationMessage[];
  annotations: ChatAnnotation[];
  onAddAnnotation: (
    messageUuid: string,
    partIndex: number,
    selectedText: string,
    startOffset: number,
    endOffset: number,
    comment: string
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  /** False while the pane is hidden (kept mounted); re-anchors on show. */
  visible?: boolean;
  /** Whether the chat's terminal is live (enables answering questions). */
  terminalReady?: boolean;
  /** Send raw keystrokes to the chat's terminal (drives TUI selectors). */
  onSendKeys?: (keys: string[]) => void;
}

/** Surface-specific anchor for a chat comment: a char range within one part. */
interface ChatAnchor {
  messageUuid: string;
  partIndex: number;
  startOffset: number;
  endOffset: number;
}

interface EditingAnn {
  annotation: ChatAnnotation;
  pos: { top: number; left: number };
}

const POPOVER_VIEWPORT_PAD = 380;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
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

/**
 * Disclosure block whose body animates open/closed via a grid-rows transition —
 * smooth, with no layout shift and no max-height guessing.
 */
function CollapsibleBlock({
  label,
  preview,
  children,
}: {
  label: string;
  preview: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
      >
        <span
          className={cn(
            "inline-block text-[9px] transition-transform duration-200",
            open && "rotate-90"
          )}
        >
          ▶
        </span>
        <span className="shrink-0 whitespace-nowrap text-[var(--text-secondary)]">
          {label}
        </span>
        {!open && preview && (
          <span className="min-w-0 truncate text-[var(--text-tertiary)]">
            {preview}
          </span>
        )}
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/** Monospace, scrollable code body used inside disclosure blocks. */
function CodeBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "max-h-[400px] select-text overflow-auto whitespace-pre-wrap break-all font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)] [cursor:text]",
        className
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

function getHighlights(): { ann: Highlight; pending: Highlight } | null {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return null;
  if (!annHighlight) {
    annHighlight = new Highlight();
    pendingHighlight = new Highlight();
    CSS.highlights.set("chat-annotation", annHighlight);
    CSS.highlights.set("chat-annotation-pending", pendingHighlight);
  }
  return { ann: annHighlight, pending: pendingHighlight! };
}

/** Build a DOM Range for [start, end) character offsets into `root`'s text. */
function rangeForOffsets(
  root: HTMLElement,
  start: number,
  end: number
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

/**
 * A markdown-rendered message text part. Existing annotations and the in-flight
 * selection are painted as custom highlights; clicking a highlighted span opens
 * its editor (hit-tested against the click point).
 */
function MarkdownText({
  text,
  messageUuid,
  partIndex,
  partAnnotations,
  pendingRange,
  onClickAnnotation,
}: {
  text: string;
  messageUuid: string;
  partIndex: number;
  partAnnotations: ChatAnnotation[];
  pendingRange: { start: number; end: number } | null;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    const hl = getHighlights();
    if (!root || !hl) return;
    const added: Array<{ set: Highlight; range: Range }> = [];
    for (const a of partAnnotations) {
      const r = rangeForOffsets(root, a.startOffset, a.endOffset);
      if (r) {
        hl.ann.add(r);
        added.push({ set: hl.ann, range: r });
      }
    }
    if (pendingRange) {
      const r = rangeForOffsets(root, pendingRange.start, pendingRange.end);
      if (r) {
        hl.pending.add(r);
        added.push({ set: hl.pending, range: r });
      }
    }
    return () => {
      for (const a of added) a.set.delete(a.range);
    };
  }, [text, partAnnotations, pendingRange]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (partAnnotations.length === 0) return;
      const root = ref.current;
      if (!root) return;
      const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!caret) return;
      const off = offsetWithin(root, caret.startContainer, caret.startOffset);
      if (off === -1) return;
      const ann = partAnnotations.find(
        (a) => a.startOffset <= off && off < a.endOffset
      );
      if (!ann) return;
      e.stopPropagation();
      const r = rangeForOffsets(root, ann.startOffset, ann.endOffset);
      const rect = r?.getBoundingClientRect() ?? root.getBoundingClientRect();
      onClickAnnotation(ann, rect);
    },
    [partAnnotations, onClickAnnotation]
  );

  return (
    <div
      ref={ref}
      data-message-uuid={messageUuid}
      data-part-index={partIndex}
      data-text-part="true"
      onClick={handleClick}
      className="select-text [cursor:text]"
    >
      <Markdown content={text} />
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

interface MessagePartViewProps {
  part: MessagePart;
  partIndex: number;
  message: ConversationMessage;
  annotations: ChatAnnotation[];
  pendingRange: { start: number; end: number } | null;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
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
}

/** Memoized: a keystroke elsewhere must not re-render every markdown block. */
const MessagePartView = memo(function MessagePartView({
  part,
  partIndex,
  message,
  annotations,
  pendingRange,
  onClickAnnotation,
  result,
  terminalReady,
  onSendKeys,
  planVersions,
  planVersionIndex,
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
      return (
        <MarkdownText
          text={part.text}
          messageUuid={message.uuid}
          partIndex={partIndex}
          partAnnotations={annotations}
          pendingRange={pendingRange}
          onClickAnnotation={onClickAnnotation}
        />
      );
    }
    case "thinking":
      return (
        <CollapsibleBlock label="💭 Thinking" preview={truncate(part.text, 120)}>
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
      // ExitPlanMode renders as a clean inline Plan card, not a raw tool block.
      // The body goes through the same annotation-aware markdown path as normal
      // assistant text, so selecting it comments via the existing chat flow.
      if (part.tool === "ExitPlanMode" && planVersionIndex >= 0) {
        const planText = planVersions[planVersionIndex]?.text ?? "";
        return (
          <PlanCard
            versions={planVersions}
            versionIndex={planVersionIndex}
            body={
              <MarkdownText
                text={planText}
                messageUuid={message.uuid}
                partIndex={partIndex}
                partAnnotations={annotations}
                pendingRange={pendingRange}
                onClickAnnotation={onClickAnnotation}
              />
            }
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
        <CollapsibleBlock
          label={`🔧 ${part.tool}`}
          preview={previewInput(part.input)}
        >
          <div className="px-3 pb-3 pt-1">
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
        </CollapsibleBlock>
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
  prev.partIndex === next.partIndex &&
  prev.message === next.message &&
  prev.annotations === next.annotations &&
  prev.onClickAnnotation === next.onClickAnnotation &&
  prev.terminalReady === next.terminalReady &&
  prev.onSendKeys === next.onSendKeys &&
  prev.planVersions === next.planVersions &&
  prev.planVersionIndex === next.planVersionIndex &&
  sameRange(prev.pendingRange, next.pendingRange) &&
  sameResult(prev.result, next.result));

function sameRange(
  a: { start: number; end: number } | null,
  b: { start: number; end: number } | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

function sameResult(a?: ToolResult, b?: ToolResult): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.output === b.output && a.isError === b.isError;
}

const EMPTY_ANNOTATIONS: ChatAnnotation[] = [];
// Stable reference for non-plan parts so the memoized part view doesn't re-render
// every time `messages` changes (only plan parts read the versions array).
const EMPTY_PLAN_VERSIONS: PlanVersionInfo[] = [];

/**
 * Memoized: the composer's state lives in the workspace, so without this every
 * keystroke would re-render the entire (non-virtualized) transcript.
 */
export const MessageList = memo(function MessageList({
  messages,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  visible = true,
  terminalReady = false,
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
        (m) => !m.parts.every((p) => p.kind === "tool_result")
      ),
    [deferredMessages]
  );

  // Every ExitPlanMode tool_use is one plan revision; in transcript order they
  // are the plan's full version history. Map each plan part to its index in
  // that sequence so its PlanCard can diff against earlier versions.
  const { planVersions, planVersionByPart } = useMemo(() => {
    const versions: PlanVersionInfo[] = [];
    const byPart = new Map<string, number>();
    for (const m of deferredMessages) {
      m.parts.forEach((p, i) => {
        if (p.kind !== "tool_use" || p.tool !== "ExitPlanMode") return;
        const text = parsePlanInput(p.input);
        if (text === null) return;
        byPart.set(`${m.uuid}:${i}`, versions.length);
        versions.push({ text, timestamp: m.timestamp });
      });
    }
    return { planVersions: versions, planVersionByPart: byPart };
  }, [deferredMessages]);
  const [editing, setEditing] = useState<EditingAnn | null>(null);

  const annotationsByMessage = useMemo(() => {
    const map = new Map<string, Map<number, ChatAnnotation[]>>();
    for (const a of annotations) {
      let m = map.get(a.messageUuid);
      if (!m) {
        m = new Map();
        map.set(a.messageUuid, m);
      }
      const list = m.get(a.partIndex) ?? [];
      list.push(a);
      m.set(a.partIndex, list);
    }
    return map;
  }, [annotations]);

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
  }, [sessionAnchorKey, items.length, deferredMessages]);

  // Becoming visible again (pane was display:none): layout was skipped while
  // hidden, so re-anchor to the bottom if we were following it.
  useLayoutEffect(() => {
    if (!visible) return;
    const el = parentRef.current;
    if (el && followingBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      followingBottomRef.current = distance < 20;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Selection → comment popover (within a single text part). Timing (when the
  // selection has settled, and catching releases outside the pane) is handled
  // by useCommentSelection; this just maps a settled selection to a chat anchor.
  const resolveSelection = useCallback((range: Range, sel: Selection) => {
    if (!parentRef.current) return null;
    if (!parentRef.current.contains(range.commonAncestorContainer)) return null;

    // Anchor on the part the selection STARTS in. A triple-click (or a
    // double-click-drag) often lands the end boundary just past the block — in
    // a sibling/ancestor with no data-part-index — so requiring both endpoints
    // in the same part silently dropped those. Instead we clamp the end into
    // the start part; cross-block selections just comment the first block.
    const part =
      ancestorWithAttr(range.startContainer, "data-part-index") ??
      ancestorWithAttr(range.endContainer, "data-part-index");
    if (!part) return null;

    const messageUuid = part.getAttribute("data-message-uuid") ?? "";
    const partIndex = parseInt(part.getAttribute("data-part-index") ?? "0", 10);
    const fullText = part.textContent ?? "";

    // Offsets within the part, derived from which of the part's text nodes the
    // selection actually covers — not from the raw endpoints. A triple-click
    // lands the end boundary on an element node just past the block (a
    // sibling/ancestor), which we can't turn into a character offset directly;
    // clamping it to the part's end would swallow every block below the one the
    // user clicked. Intersecting per text node confines us to what's selected.
    const offsets = selectedOffsetsWithin(part, range);
    if (!offsets) return null;
    let { start, end } = offsets;

    // Trim whitespace by moving the offsets, so text and offsets stay in sync.
    while (start < end && /\s/.test(fullText[start])) start++;
    while (end > start && /\s/.test(fullText[end - 1])) end--;
    const selectedText = fullText.slice(start, end);
    if (!selectedText) return null;

    const rect = range.getBoundingClientRect();
    return {
      data: { messageUuid, partIndex, startOffset: start, endOffset: end },
      selectedText,
      position: {
        top: rect.bottom + 8,
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
        ),
      },
    };
  }, []);

  const createAnnotation = useCallback(
    (data: ChatAnchor, selectedText: string, comment: string) => {
      onAddAnnotation(
        data.messageUuid,
        data.partIndex,
        selectedText,
        data.startOffset,
        data.endOffset,
        comment
      );
    },
    [onAddAnnotation]
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
    [editing, onUpdateAnnotation]
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
            Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
          ),
        },
      }),
    []
  );

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No messages
      </div>
    );
  }

  return (
    <>
      <div ref={parentRef} className="h-full overflow-auto py-3">
        {items.map((m, idx) => {
          const partMap = annotationsByMessage.get(m.uuid);
          const showHeader = showHeaderForRow[idx];
          // iMessage-style: user turns are a right-aligned bubble capped in
          // width; assistant turns run full-width with no bubble.
          const isUser = classify(m) === "user-real";
          return (
            <div
              key={m.uuid || idx}
              className={cn(
                // content-visibility lets the browser skip layout/paint of
                // off-screen rows — width changes (sidebar toggles) would
                // otherwise reflow the entire transcript.
                "flex px-4 [content-visibility:auto] [contain-intrinsic-block-size:auto_140px]",
                showHeader ? "pt-4 pb-2" : "pt-1 pb-2",
                isUser ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={cn(
                  "flex flex-col gap-1.5",
                  isUser
                    ? "max-w-[80%] rounded-2xl rounded-br-sm border border-[var(--border)] bg-[var(--bg-surface)] px-3.5 py-2"
                    : "w-full"
                )}
              >
                {m.parts.map((p, i) => {
                  const planVersionIndex =
                    planVersionByPart.get(`${m.uuid}:${i}`) ?? -1;
                  return (
                  <MessagePartView
                    key={i}
                    part={p}
                    partIndex={i}
                    message={m}
                    annotations={partMap?.get(i) ?? EMPTY_ANNOTATIONS}
                    pendingRange={
                      pending &&
                      pending.data.messageUuid === m.uuid &&
                      pending.data.partIndex === i
                        ? {
                            start: pending.data.startOffset,
                            end: pending.data.endOffset,
                          }
                        : null
                    }
                    onClickAnnotation={handleClickAnnotation}
                    result={
                      p.kind === "tool_use"
                        ? resultByToolUseId.get(p.id)
                        : undefined
                    }
                    terminalReady={terminalReady}
                    onSendKeys={onSendKeys}
                    planVersions={
                      planVersionIndex >= 0 ? planVersions : EMPTY_PLAN_VERSIONS
                    }
                    planVersionIndex={planVersionIndex}
                  />
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

function ancestorWithAttr(node: Node, attr: string): HTMLElement | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement
      ? node
      : node.parentElement;
  while (el) {
    if (el.hasAttribute(attr)) return el;
    el = el.parentElement;
  }
  return null;
}

function offsetWithin(root: HTMLElement, node: Node, nodeOff: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
  range: Range
): { start: number; end: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
