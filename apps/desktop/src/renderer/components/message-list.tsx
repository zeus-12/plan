import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@plan/shared/lib/utils";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { Markdown } from "@plan/shared/components/markdown";
import { AskQuestionCard, parseAskInput } from "./ask-question-card";
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

interface PendingSel {
  messageUuid: string;
  partIndex: number;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  popoverPos: { top: number; left: number };
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
        <span className="text-[var(--text-secondary)]">{label}</span>
        {!open && preview && (
          <span className="truncate text-[var(--text-tertiary)]">
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
}: MessagePartViewProps) {
  switch (part.kind) {
    case "text":
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

  // Pair tool_result → tool_use (by id) so results render inside their tool
  // block, and drop the now-empty result-only messages from the timeline.
  const resultByToolUseId = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.kind === "tool_result") {
          map.set(p.toolUseId, { output: p.output, isError: p.isError });
        }
      }
    }
    return map;
  }, [messages]);

  const items = useMemo(
    () => messages.filter((m) => !m.parts.every((p) => p.kind === "tool_result")),
    [messages]
  );
  const [pending, setPending] = useState<PendingSel | null>(null);
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
  }, [sessionAnchorKey, items.length, messages]);

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

  // Selection → comment popover (within a single text part)
  const handleMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !parentRef.current) return;
      const range = sel.getRangeAt(0);
      if (!parentRef.current.contains(range.commonAncestorContainer)) return;

      // Selection must live entirely inside a single text-part block
      const startPart = ancestorWithAttr(range.startContainer, "data-part-index");
      const endPart = ancestorWithAttr(range.endContainer, "data-part-index");
      if (!startPart || !endPart || startPart !== endPart) {
        sel.removeAllRanges();
        return;
      }
      const messageUuid = startPart.getAttribute("data-message-uuid") ?? "";
      const partIndexStr = startPart.getAttribute("data-part-index") ?? "0";
      const partIndex = parseInt(partIndexStr, 10);

      const text = sel.toString();
      if (!text.trim()) return;

      const startOffset = offsetWithin(startPart, range.startContainer, range.startOffset);
      const endOffset = offsetWithin(startPart, range.endContainer, range.endOffset);
      if (startOffset === -1 || endOffset === -1) return;

      const rect = range.getBoundingClientRect();
      setPending({
        messageUuid,
        partIndex,
        selectedText: text.trim(),
        startOffset,
        endOffset,
        popoverPos: {
          top: rect.bottom + 8,
          left: Math.max(
            8,
            Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
          ),
        },
      });
    });
  }, []);

  const submitNew = useCallback(
    (comment: string) => {
      if (!pending) return;
      onAddAnnotation(
        pending.messageUuid,
        pending.partIndex,
        pending.selectedText,
        pending.startOffset,
        pending.endOffset,
        comment
      );
      setPending(null);
      window.getSelection()?.removeAllRanges();
    },
    [pending, onAddAnnotation]
  );

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
      <div
        ref={parentRef}
        onMouseUp={handleMouseUp}
        className="h-full overflow-auto py-3"
      >
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
                {m.parts.map((p, i) => (
                  <MessagePartView
                    key={i}
                    part={p}
                    partIndex={i}
                    message={m}
                    annotations={partMap?.get(i) ?? EMPTY_ANNOTATIONS}
                    pendingRange={
                      pending &&
                      pending.messageUuid === m.uuid &&
                      pending.partIndex === i
                        ? {
                            start: pending.startOffset,
                            end: pending.endOffset,
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
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {pending && (
        <CommentPopover
          position={pending.popoverPos}
          selectedText={pending.selectedText}
          onSubmit={submitNew}
          onClose={() => {
            setPending(null);
            window.getSelection()?.removeAllRanges();
          }}
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
