import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@plan/shared/lib/utils";
import { CommentPopover } from "@plan/shared/components/comment-popover";
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

function categoryHeader(cat: MessageCategory): string | null {
  switch (cat) {
    case "user-real":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return null;
  }
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

function CollapsibleBlock({
  label,
  preview,
  full,
}: {
  label: string;
  preview: string;
  full: string;
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
            "inline-block text-[9px] transition-transform",
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
      {open && (
        <pre className="max-h-[400px] select-text overflow-auto whitespace-pre-wrap break-all px-3 pb-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)] [cursor:text]">
          {full}
        </pre>
      )}
    </div>
  );
}

/**
 * Render a text part with per-character annotation overlays so existing
 * annotations stay visible when their host message scrolls back into view.
 */
function AnnotatedText({
  text,
  partAnnotations,
  pendingRange,
  onClickAnnotation,
  onHover,
  hoveredId,
}: {
  text: string;
  partAnnotations: ChatAnnotation[];
  /** The in-progress selection (popover open) — kept visually highlighted
   *  since the native selection clears once the popover textarea focuses. */
  pendingRange: { start: number; end: number } | null;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
  onHover: (id: string | null) => void;
  hoveredId: string | null;
}) {
  if (partAnnotations.length === 0 && !pendingRange) {
    return (
      <pre
        data-text-part="true"
        className="select-text whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[var(--text)] [cursor:text]"
      >
        {text}
      </pre>
    );
  }

  // Build flat boundaries and emit spans
  const bounds = new Set<number>([0, text.length]);
  for (const a of partAnnotations) {
    bounds.add(a.startOffset);
    bounds.add(a.endOffset);
  }
  if (pendingRange) {
    bounds.add(pendingRange.start);
    bounds.add(pendingRange.end);
  }
  const sorted = [...bounds]
    .filter((b) => b >= 0 && b <= text.length)
    .sort((a, b) => a - b);

  const parts: React.ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (s >= e) continue;
    const ann = partAnnotations.find(
      (a) => a.startOffset <= s && s < a.endOffset
    );
    const isPending =
      !ann &&
      pendingRange != null &&
      pendingRange.start <= s &&
      s < pendingRange.end;
    const hovered = ann && hoveredId === ann.id;
    parts.push(
      <span
        key={s}
        className={cn(
          ann &&
            "cursor-pointer rounded-sm border-b-[1.5px] border-[var(--text-tertiary)]",
          isPending && "rounded-sm"
        )}
        style={
          ann
            ? {
                background: hovered
                  ? "var(--highlight-bg-hover)"
                  : "var(--highlight-bg)",
              }
            : isPending
              ? { background: "var(--selection-bg)" }
              : undefined
        }
        onClick={
          ann
            ? (event) => {
                event.stopPropagation();
                onClickAnnotation(
                  ann,
                  (event.currentTarget as HTMLElement).getBoundingClientRect()
                );
              }
            : undefined
        }
        onMouseEnter={ann ? () => onHover(ann.id) : undefined}
        onMouseLeave={ann ? () => onHover(null) : undefined}
      >
        {text.slice(s, e)}
      </span>
    );
  }

  return (
    <pre
      data-text-part="true"
      className="select-text whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[var(--text)] [cursor:text]"
    >
      {parts}
    </pre>
  );
}

function MessagePartView({
  part,
  partIndex,
  message,
  annotations,
  pendingRange,
  onClickAnnotation,
  hoveredId,
  onHover,
}: {
  part: MessagePart;
  partIndex: number;
  message: ConversationMessage;
  annotations: ChatAnnotation[];
  pendingRange: { start: number; end: number } | null;
  onClickAnnotation: (ann: ChatAnnotation, rect: DOMRect) => void;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
}) {
  switch (part.kind) {
    case "text":
      return (
        <div
          data-message-uuid={message.uuid}
          data-part-index={partIndex}
        >
          <AnnotatedText
            text={part.text}
            partAnnotations={annotations}
            pendingRange={pendingRange}
            onClickAnnotation={onClickAnnotation}
            hoveredId={hoveredId}
            onHover={onHover}
          />
        </div>
      );
    case "thinking":
      return (
        <CollapsibleBlock
          label="thinking"
          preview={truncate(part.text, 120)}
          full={part.text}
        />
      );
    case "tool_use":
      return (
        <CollapsibleBlock
          label={`tool: ${part.tool}`}
          preview={previewInput(part.input)}
          full={(() => {
            try {
              return JSON.stringify(part.input, null, 2);
            } catch {
              return String(part.input);
            }
          })()}
        />
      );
    case "tool_result":
      return (
        <CollapsibleBlock
          label={part.isError ? "tool result (error)" : "tool result"}
          preview={truncate(part.output.split("\n")[0] ?? "", 120)}
          full={part.output}
        />
      );
  }
}

export function MessageList({
  messages,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => messages, [messages]);
  const [pending, setPending] = useState<PendingSel | null>(null);
  const [editing, setEditing] = useState<EditingAnn | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  /**
   * Stick-to-bottom in one shot: synchronously, before paint, on every render
   * the user is "following the bottom". Re-runs each time `totalSize` changes
   * (every row measurement) so the user never sees an intermediate scrolled-
   * to-top state — first paint already shows the bottom.
   *
   * Whether we're "following the bottom" is derived purely from the scroll
   * element's actual position (distance < 20px = following). No
   * "programmatic vs user" flag — the natural invariant tracks both cases.
   */
  const sessionAnchorKey = items[0]?.uuid ?? `len-${items.length}`;
  const sessionKeyRef = useRef<string | null>(null);
  const followingBottomRef = useRef(true);
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    if (items.length === 0) {
      sessionKeyRef.current = null;
      followingBottomRef.current = true;
      return;
    }
    const el = parentRef.current;
    if (!el) return;

    // Reset on session change so we always anchor a freshly-opened chat.
    if (sessionKeyRef.current !== sessionAnchorKey) {
      sessionKeyRef.current = sessionAnchorKey;
      followingBottomRef.current = true;
    }

    if (followingBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sessionAnchorKey, items.length, totalSize]);

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
        className="h-full overflow-auto"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const m = items[vi.index];
            const partMap = annotationsByMessage.get(m.uuid);
            const showHeader = showHeaderForRow[vi.index];
            const headerLabel = showHeader ? categoryHeader(classify(m)) : null;
            return (
              <div
                key={m.uuid || `${vi.index}`}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute left-0 top-0 w-full px-4",
                  showHeader ? "pt-4 pb-2" : "pt-1 pb-2"
                )}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className="flex flex-col gap-1.5">
                  {headerLabel && (
                    <span
                      className={cn(
                        "font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider",
                        headerLabel === "user"
                          ? "text-[var(--accent)]"
                          : "text-[var(--text-tertiary)]"
                      )}
                    >
                      {headerLabel}
                    </span>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {m.parts.map((p, i) => (
                      <MessagePartView
                        key={i}
                        part={p}
                        partIndex={i}
                        message={m}
                        annotations={partMap?.get(i) ?? []}
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
                        onClickAnnotation={(ann, rect) =>
                          setEditing({
                            annotation: ann,
                            pos: {
                              top: rect.bottom + 8,
                              left: Math.max(
                                8,
                                Math.min(
                                  rect.left,
                                  window.innerWidth - POPOVER_VIEWPORT_PAD
                                )
                              ),
                            },
                          })
                        }
                        hoveredId={hoveredId}
                        onHover={setHoveredId}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
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
}

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
