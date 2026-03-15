"use client";

import { useRef, useState, useMemo, type ReactNode } from "react";
import type { Annotation } from "@/lib/store";
import type { DiffSettings } from "@/lib/settings";
import {
  type DiffLine,
  type FilteredItem,
  type SplitRow,
  buildDiffLines,
  filterUnchangedLines,
  buildSplitRows,
  getDiffLineForOffset,
} from "@/lib/diff";
import { CommentPopover } from "./comment-popover";

/* ── Constants ────────────────────────────────────────────── */

const LINE_HEIGHT_PX = 22;
const SEPARATOR_HEIGHT_PX = 28;
const COMMENT_CARD_HEIGHT_PX = 58;
const COMMENT_GAP_PX = 6;
const COMMENT_TRUNCATE_LEN = 55;
const POPOVER_VIEWPORT_PAD = 380;

/* ── Types ────────────────────────────────────────────────── */

interface PendingSel {
  selectedText: string;
  startOffset: number;
  endOffset: number;
  popoverPos: { top: number; left: number };
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
  annotations?: Annotation[];
  onAddAnnotation?: (
    sel: string,
    start: number,
    end: number,
    comment: string
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
}

/* ── Helpers ──────────────────────────────────────────────── */

function layoutComments(
  anns: Annotation[],
  dLines: DiffLine[]
): Array<{ annotation: Annotation; top: number; index: number }> {
  const items = anns.map((a, i) => ({
    annotation: a,
    idealTop: getDiffLineForOffset(a.startOffset, dLines) * LINE_HEIGHT_PX,
    index: i,
  }));
  items.sort((a, b) => a.idealTop - b.idealTop);

  let lastBottom = 0;
  return items.map((item) => {
    const top = Math.max(item.idealTop, lastBottom);
    lastBottom = top + COMMENT_CARD_HEIGHT_PX + COMMENT_GAP_PX;
    return { ...item, top };
  });
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

/* ── Component ────────────────────────────────────────────── */

export function InteractiveDiff({
  oldText,
  newText,
  settings,
  onSettingsChange,
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [hoveredAnnId, setHoveredAnnId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSel | null>(null);
  const [editing, setEditing] = useState<EditingAnn | null>(null);

  const interactive = !!onAddAnnotation;
  const hasAnns = annotations.length > 0;

  const dLines = useMemo(
    () => buildDiffLines(oldText, newText),
    [oldText, newText]
  );

  const filtered: FilteredItem[] = useMemo(() => {
    if (!settings.hideUnchanged) return dLines;
    return filterUnchangedLines(dLines);
  }, [dLines, settings.hideUnchanged]);

  const splitRows: SplitRow[] = useMemo(
    () => buildSplitRows(filtered),
    [filtered]
  );

  const commentPositions = useMemo(
    () => (hasAnns ? layoutComments(annotations, dLines) : []),
    [annotations, dLines, hasAnns]
  );

  const lastCmt = commentPositions.at(-1);
  const railHeight = lastCmt
    ? lastCmt.top + COMMENT_CARD_HEIGHT_PX + 16
    : 0;

  // Digit width for line number columns
  const maxOld = dLines.reduce((m, l) => Math.max(m, l.oldNum ?? 0), 0);
  const maxNew = dLines.reduce((m, l) => Math.max(m, l.newNum ?? 0), 0);
  const numDigits = Math.max(String(maxOld).length, String(maxNew).length, 1);
  const numColW = numDigits * 8 + 12;

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

  /* ── Selection ──────────────────────────────────────────── */

  function handleMouseUp() {
    if (!interactive) return;
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !contentRef.current) return;
      const range = sel.getRangeAt(0);
      if (!contentRef.current.contains(range.commonAncestorContainer)) return;
      const text = sel.toString();
      if (!text.trim()) return;

      const start = getAbsoluteOffset(range.startContainer, range.startOffset);
      const end = getAbsoluteOffset(range.endContainer, range.endOffset);
      if (start === -1 || end === -1) return;

      const rect = range.getBoundingClientRect();
      setPending({
        selectedText: text.trim(),
        startOffset: start,
        endOffset: end,
        popoverPos: {
          top: rect.bottom + 8,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)),
        },
      });
    });
  }

  function submitNew(comment: string) {
    if (!pending || !onAddAnnotation) return;
    onAddAnnotation(
      pending.selectedText,
      pending.startOffset,
      pending.endOffset,
      comment
    );
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }

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
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)),
      },
    });
  }

  /* ── Highlights ─────────────────────────────────────────── */

  type Hl = { s: number; e: number; kind: "ann" | "pending"; annId?: string };

  function hlsForLine(lineIdx: number): Hl[] {
    const line = dLines[lineIdx];
    const ls = line.flatOffset;
    const le = ls + line.content.length;
    const out: Hl[] = [];

    for (const a of annotations) {
      if (a.startOffset < le && a.endOffset > ls) {
        out.push({
          s: Math.max(a.startOffset, ls) - ls,
          e: Math.min(a.endOffset, le) - ls,
          kind: "ann",
          annId: a.id,
        });
      }
    }

    if (pending && pending.startOffset < le && pending.endOffset > ls) {
      out.push({
        s: Math.max(pending.startOffset, ls) - ls,
        e: Math.min(pending.endOffset, le) - ls,
        kind: "pending",
      });
    }

    return out.sort((a, b) => a.s - b.s);
  }

  function renderContent(lineIdx: number): ReactNode {
    const txt = dLines[lineIdx].content;
    const hls = hlsForLine(lineIdx);
    if (hls.length === 0) return txt || "\u00A0";

    const parts: ReactNode[] = [];
    let cur = 0;

    for (const hl of hls) {
      if (hl.s > cur) {
        parts.push(<span key={`t${cur}`}>{txt.slice(cur, hl.s)}</span>);
      }
      const isAnn = hl.kind === "ann";
      const hovered = isAnn && hoveredAnnId === hl.annId;

      parts.push(
        <span
          key={`h${hl.s}${hl.kind}${hl.annId ?? ""}`}
          className={isAnn ? "cursor-pointer" : ""}
          style={{
            background: hovered
              ? "var(--highlight-bg-hover)"
              : isAnn
                ? "var(--highlight-bg)"
                : "var(--selection-bg)",
            borderBottom: isAnn ? "1.5px solid var(--text-tertiary)" : undefined,
            borderRadius: "2px",
          }}
          onClick={
            isAnn
              ? (e) => {
                  e.stopPropagation();
                  const ann = annotations.find((a) => a.id === hl.annId);
                  if (ann)
                    openEdit(
                      ann,
                      (e.currentTarget as HTMLElement).getBoundingClientRect()
                    );
                }
              : undefined
          }
          onMouseEnter={isAnn ? () => setHoveredAnnId(hl.annId!) : undefined}
          onMouseLeave={isAnn ? () => setHoveredAnnId(null) : undefined}
        >
          {txt.slice(hl.s, hl.e)}
        </span>
      );
      cur = hl.e;
    }

    if (cur < txt.length) {
      parts.push(<span key={`t${cur}`}>{txt.slice(cur)}</span>);
    }
    return <>{parts}</>;
  }

  /* ── Shared line renderers ──────────────────────────────── */

  const lineNumStyle = (type: DiffLine["type"], hide?: boolean) => ({
    height: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    minWidth: numColW,
    color: hide ? "transparent" : "var(--text-tertiary)",
    background: gutterBg(type),
    fontSize: 10,
  });

  const lineContentStyle = (type: DiffLine["type"]) => ({
    height: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    color: "var(--text)" as const,
    background: lineBg(type),
  });

  function renderSeparator(count: number, key: string | number, colSpan?: boolean) {
    return (
      <div
        key={key}
        className="flex select-none items-center justify-center font-[family-name:var(--font-mono)] text-[11px]"
        style={{
          height: SEPARATOR_HEIGHT_PX,
          background: "var(--bg)",
          color: "var(--text-tertiary)",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          ...(colSpan ? {} : {}),
        }}
      >
        ⋯ {count} unchanged lines
      </div>
    );
  }

  /* ── Settings bar ───────────────────────────────────────── */

  function renderSettingsBar() {
    if (!onSettingsChange) return null;
    return (
      <div className="mb-2 flex items-center justify-end gap-2">
        <div
          className="inline-flex rounded-md border font-[family-name:var(--font-mono)] text-[11px]"
          style={{ borderColor: "var(--border)" }}
        >
          {(["split", "unified"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onSettingsChange({ viewMode: mode })}
              className={`px-2.5 py-1 transition-colors ${mode === "split" ? "rounded-l-md" : "rounded-r-md border-l"}`}
              style={{
                borderColor: "var(--border)",
                background:
                  settings.viewMode === mode ? "var(--accent)" : "transparent",
                color:
                  settings.viewMode === mode
                    ? "var(--bg)"
                    : "var(--text-tertiary)",
              }}
            >
              {mode === "split" ? "Split" : "Unified"}
            </button>
          ))}
        </div>
        <button
          onClick={() =>
            onSettingsChange({ hideUnchanged: !settings.hideUnchanged })
          }
          className="rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-tertiary)",
          }}
        >
          {settings.hideUnchanged ? "Show all lines" : "Hide unchanged"}
        </button>
      </div>
    );
  }

  /* ── Unified view ───────────────────────────────────────── */

  function renderUnified() {
    return (
      <div className="flex">
        {/* Bar */}
        <div className="shrink-0 pt-2 pb-2" style={{ width: 3 }}>
          {filtered.map((item, i) =>
            item.type === "separator" ? (
              <div key={`b${i}`} style={{ height: SEPARATOR_HEIGHT_PX }} />
            ) : (
              <div
                key={`b${i}`}
                style={{ height: LINE_HEIGHT_PX, background: barColor(item.type) }}
              />
            )
          )}
        </div>

        {/* Old nums */}
        <div
          className="shrink-0 select-none pt-2 pb-2"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          {filtered.map((item, i) =>
            item.type === "separator" ? (
              <div key={`on${i}`} style={{ height: SEPARATOR_HEIGHT_PX }} />
            ) : (
              <div
                key={`on${i}`}
                className="flex items-center justify-end px-2 font-[family-name:var(--font-mono)]"
                style={lineNumStyle(item.type, item.type === "add")}
              >
                {item.oldNum ?? ""}
              </div>
            )
          )}
        </div>

        {/* New nums */}
        <div
          className="shrink-0 select-none pt-2 pb-2"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          {filtered.map((item, i) =>
            item.type === "separator" ? (
              <div key={`nn${i}`} style={{ height: SEPARATOR_HEIGHT_PX }} />
            ) : (
              <div
                key={`nn${i}`}
                className="flex items-center justify-end px-2 font-[family-name:var(--font-mono)]"
                style={lineNumStyle(item.type, item.type === "remove")}
              >
                {item.newNum ?? ""}
              </div>
            )
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 select-text overflow-x-auto pt-2 pb-2">
          <div className="w-max min-w-full">
            {filtered.map((item, i) =>
              item.type === "separator" ? (
                renderSeparator(item.hiddenCount, `s${i}`)
              ) : (
                <div
                  key={`c${i}`}
                  data-dline={item.idx}
                  className="whitespace-pre pl-3 pr-4 font-[family-name:var(--font-mono)] text-[13px]"
                  style={lineContentStyle(item.type)}
                >
                  {renderContent(item.idx)}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ── Split view ─────────────────────────────────────────── */

  function renderSplitHalf(
    line: DiffLine | undefined,
    side: "left" | "right",
    key: string
  ) {
    if (!line) {
      return (
        <div
          key={key}
          className="flex min-w-0 flex-1"
          style={{
            height: LINE_HEIGHT_PX,
            background: "var(--bg)",
          }}
        >
          <div
            className="shrink-0 select-none px-2 font-[family-name:var(--font-mono)]"
            style={{
              ...lineNumStyle("context", true),
              background: "var(--bg)",
            }}
          />
          <div className="shrink-0" style={{ width: 3, background: "transparent" }} />
          <div className="flex-1" />
        </div>
      );
    }

    const num = side === "left" ? line.oldNum : line.newNum;
    const hideNum =
      (side === "left" && line.type === "add") ||
      (side === "right" && line.type === "remove");

    return (
      <div key={key} className="flex min-w-0 flex-1">
        <div
          className="shrink-0 select-none px-2 font-[family-name:var(--font-mono)]"
          style={{
            ...lineNumStyle(line.type, hideNum),
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          {hideNum ? "" : (num ?? "")}
        </div>
        <div
          className="shrink-0"
          style={{ width: 3, height: LINE_HEIGHT_PX, background: barColor(line.type) }}
        />
        <div
          data-dline={line.idx}
          className="min-w-0 flex-1 whitespace-pre pl-3 pr-4 font-[family-name:var(--font-mono)] text-[13px]"
          style={lineContentStyle(line.type)}
        >
          {renderContent(line.idx)}
        </div>
      </div>
    );
  }

  function renderSplit() {
    return (
      <div>
        {splitRows.map((row, i) => {
          if (row.type === "separator") {
            return renderSeparator(row.hiddenCount, `sep${i}`);
          }
          return (
            <div
              key={`row${i}`}
              className="flex"
              style={{
                borderBottom:
                  i < splitRows.length - 1
                    ? undefined
                    : undefined,
              }}
            >
              <div
                className="flex min-w-0 flex-1 select-text overflow-x-auto"
                style={{ borderRight: "1px solid var(--border)" }}
              >
                {renderSplitHalf(row.left, "left", `l${i}`)}
              </div>
              <div className="flex min-w-0 flex-1 select-text overflow-x-auto">
                {renderSplitHalf(row.right, "right", `r${i}`)}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /* ── Main render ────────────────────────────────────────── */

  return (
    <div className="relative">
      {renderSettingsBar()}

      <div className="flex gap-5">
        {/* Diff block — centered */}
        <div
          ref={contentRef}
          onMouseUp={handleMouseUp}
          className="min-w-0 flex-1 overflow-hidden rounded-lg border"
          style={{
            background: "var(--bg-surface)",
            borderColor: "var(--border)",
          }}
        >
          {settings.viewMode === "unified" ? renderUnified() : renderSplit()}
        </div>

        {/* Comments rail — outside the diff box */}
        {hasAnns && interactive && (
          <div
            className="relative w-52 shrink-0 pt-2"
            style={{ minHeight: railHeight + 16 }}
          >
            {commentPositions.map(({ annotation: ann, top, index }) => {
              const hovered = hoveredAnnId === ann.id;
              const trunc =
                ann.comment.length > COMMENT_TRUNCATE_LEN
                  ? ann.comment.slice(0, COMMENT_TRUNCATE_LEN) + "..."
                  : ann.comment;

              return (
                <div
                  key={ann.id}
                  className="absolute left-0 right-0 cursor-pointer rounded-lg border p-2.5 transition-all"
                  style={{
                    top: top + 8,
                    borderColor: hovered ? "var(--border-strong)" : "var(--border)",
                    background: hovered ? "var(--bg-surface-hover)" : "var(--bg-surface)",
                    boxShadow: hovered ? "0 2px 8px rgba(0,0,0,0.08)" : "none",
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
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold"
                      style={{ background: "var(--accent)", color: "var(--bg)" }}
                    >
                      {index + 1}
                    </span>
                    <span
                      className="text-[11px] leading-snug"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {trunc}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Popovers */}
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
            onRemoveAnnotation?.(editing.annotation.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
