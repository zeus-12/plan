"use client";

import {
  useRef,
  useState,
  useMemo,
  useCallback,
  useEffect,
  Fragment,
  type ReactNode,
} from "react";
import type { Annotation } from "@/lib/store";
import { type DiffSettings, FONT_SIZE_OPTIONS } from "@/lib/settings";
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
const SEPARATOR_HEIGHT_PX = 32;
const COMMENT_TRUNCATE_LEN = 55;
const INLINE_COMMENT_ROW_HEIGHT_PX = 32;
const POPOVER_VIEWPORT_PAD = 380;
const NUM_DIGIT_WIDTH = 8;
const NUM_COL_PAD = 12;
const BAR_WIDTH_PX = 3;
const GUTTER_FONT_SIZE = 11;

/* ── Types ────────────────────────────────────────────────── */

interface PendingSel {
  selectedText: string;
  startOffset: number;
  endOffset: number;
  popoverPos: { top: number; left: number };
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
  annotations?: Annotation[];
  onAddAnnotation?: (
    sel: string,
    start: number,
    end: number,
    comment: string,
    side: "left" | "right"
  ) => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
}

/* ── Style helpers ────────────────────────────────────────── */

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
  isFirstVersion = false,
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [hoveredAnnId, setHoveredAnnId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSel | null>(null);
  const [editing, setEditing] = useState<EditingAnn | null>(null);
  const [expandedSeparators, setExpandedSeparators] = useState<Set<number>>(
    new Set()
  );

  const interactive = !!onAddAnnotation;
  const effectiveViewMode = isFirstVersion ? "unified" : settings.viewMode;

  useEffect(() => {
    setExpandedSeparators(new Set());
  }, [oldText, newText, settings.hideUnchanged]);

  /* ── Diff computation ───────────────────────────────────── */

  const dLines = useMemo(
    () => buildDiffLines(oldText, newText),
    [oldText, newText]
  );

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
    [expandedFiltered]
  );

  /* ── Inline comment positions (by end line) ─────────────── */

  const annotationsByEndLine = useMemo(() => {
    const map = new Map<number, { annotation: Annotation; index: number }[]>();
    annotations.forEach((a, i) => {
      const lineIdx = getDiffLineForOffset(
        Math.max(0, a.endOffset - 1),
        dLines
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
    0
  );
  const numDigits = Math.max(String(maxLineNum).length, 1);
  const numColW = numDigits * NUM_DIGIT_WIDTH + NUM_COL_PAD;

  /* ── Separator toggle ───────────────────────────────────── */

  const toggleSeparator = useCallback((idx: number) => {
    setExpandedSeparators((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
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

  /* ── Selection ──────────────────────────────────────────── */

  function handleMouseUp() {
    if (!interactive) return;
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !contentRef.current) return;
      const range = sel.getRangeAt(0);
      if (!contentRef.current.contains(range.commonAncestorContainer)) return;

      let side: "left" | "right" = "right";

      if (effectiveViewMode === "split") {
        const startSide = findSplitSide(range.startContainer);
        const endSide = findSplitSide(range.endContainer);
        if (!startSide || !endSide || startSide !== endSide) {
          sel.removeAllRanges();
          return;
        }
        if (startSide === "left") side = "left";
      }

      const text = sel.toString();
      if (!text.trim()) return;

      const start = getAbsoluteOffset(range.startContainer, range.startOffset);
      const end = getAbsoluteOffset(range.endContainer, range.endOffset);
      if (start === -1 || end === -1) return;

      // In unified view, determine side from the diff line type
      if (effectiveViewMode === "unified") {
        const lineIdx = getDiffLineForOffset(start, dLines);
        if (dLines[lineIdx]?.type === "remove") side = "left";
      }

      const rect = range.getBoundingClientRect();
      setPending({
        selectedText: text.trim(),
        startOffset: start,
        endOffset: end,
        side,
        popoverPos: {
          top: rect.bottom + 8,
          left: Math.max(
            8,
            Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
          ),
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
      comment,
      pending.side
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
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - POPOVER_VIEWPORT_PAD)
        ),
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

  function renderWordSegments(line: DiffLine): ReactNode {
    const segs = line.wordSegments!;
    const wordBg =
      line.type === "add"
        ? "bg-[var(--diff-add-word)]"
        : "bg-[var(--diff-remove-word)]";

    return (
      <>
        {segs.map((seg, i) =>
          seg.changed ? (
            <span key={i} className={`${wordBg} rounded-sm`}>
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </>
    );
  }

  function renderContent(lineIdx: number): ReactNode {
    const line = dLines[lineIdx];
    const txt = line.content;
    const hls = hlsForLine(lineIdx);

    if (hls.length === 0) {
      if (line.wordSegments && line.wordSegments.length > 0) {
        return renderWordSegments(line);
      }
      return txt || "\u00A0";
    }

    const parts: ReactNode[] = [];
    let cur = 0;

    for (const hl of hls) {
      const s = Math.max(hl.s, cur);
      if (s >= hl.e) continue;

      if (s > cur) {
        parts.push(<span key={`t${cur}`}>{txt.slice(cur, s)}</span>);
      }

      const isAnn = hl.kind === "ann";
      const hovered = isAnn && hoveredAnnId === hl.annId;

      parts.push(
        <span
          key={`h${s}${hl.kind}${hl.annId ?? ""}`}
          className={`rounded-sm ${isAnn ? "cursor-pointer border-b-[1.5px] border-[var(--text-tertiary)]" : ""}`}
          style={{
            background: hovered
              ? "var(--highlight-bg-hover)"
              : isAnn
                ? "var(--highlight-bg)"
                : "var(--selection-bg)",
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
          {txt.slice(s, hl.e)}
        </span>
      );
      cur = hl.e;
    }

    if (cur < txt.length) {
      parts.push(<span key={`t${cur}`}>{txt.slice(cur)}</span>);
    }
    return <>{parts}</>;
  }

  /* ── Shared cell styles ─────────────────────────────────── */

  const numCellStyle = (
    type: DiffLine["type"],
    hide?: boolean
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
    height: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    fontSize: settings.fontSize,
    color: "var(--text)",
    background: lineBg(type),
    whiteSpace: "pre",
    paddingLeft: 12,
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

  /* ── Inline comment card ─────────────────────────────────── */

  function renderInlineComment(ann: Annotation, index: number) {
    const hovered = hoveredAnnId === ann.id;

    const trunc =
      ann.comment.length > COMMENT_TRUNCATE_LEN
        ? ann.comment.slice(0, COMMENT_TRUNCATE_LEN) + "..."
        : ann.comment;

    return (
      <div
        className="flex cursor-pointer items-start gap-2 py-1.5 pl-4 pr-3"
        style={{
          background: hovered ? "var(--bg-surface-hover)" : "var(--bg)",
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
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[8px] font-bold text-[var(--bg)]">
          {index + 1}
        </span>
        <span className="text-[11px] leading-snug text-[var(--text-secondary)]">
          {trunc}
        </span>
      </div>
    );
  }

  /* ── Settings bar ───────────────────────────────────────── */

  function renderSettingsBar() {
    if (!onSettingsChange) return null;
    return (
      <div className="mb-2 flex items-center justify-end gap-2">
        {!isFirstVersion && (
          <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
            {(["split", "unified"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => onSettingsChange({ viewMode: mode })}
                className={`px-2.5 py-1 transition-colors ${mode === "split" ? "rounded-l-md" : "rounded-r-md border-l border-[var(--border)]"} ${
                  settings.viewMode === mode
                    ? "bg-[var(--accent)] text-[var(--bg)]"
                    : "text-[var(--text-tertiary)]"
                }`}
              >
                {mode === "split" ? "Split" : "Unified"}
              </button>
            ))}
          </div>
        )}
        <select
          value={settings.fontSize}
          onChange={(e) =>
            onSettingsChange({
              fontSize: Number(e.target.value) as DiffSettings["fontSize"],
            })
          }
          className="cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-transparent px-2 py-1 pr-5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 4px center",
          }}
        >
          {FONT_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>
        <button
          onClick={() =>
            onSettingsChange({ hideUnchanged: !settings.hideUnchanged })
          }
          className="rounded-md border border-[var(--border)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors"
        >
          {settings.hideUnchanged ? "Show all lines" : "Hide unchanged"}
        </button>
      </div>
    );
  }

  /* ── Separator row ─────────────────────────────────────── */

  function renderSeparatorTd(
    colSpan: number,
    hiddenCount: number,
    sepIdx: number
  ) {
    return (
      <td
        colSpan={colSpan}
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
      <div className="overflow-x-auto [container-type:inline-size]">
        <table
          className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]"
        >
          <tbody>
            {expandedFiltered.map((item, i) => {
              if (item.type === "separator") {
                return (
                  <tr key={`us${i}`}>
                    {renderSeparatorTd(colCount, item.hiddenCount, sepIndices[i])}
                  </tr>
                );
              }

              const lineAnns = annotationsByEndLine.get(item.idx);

              return (
                <Fragment key={`u${i}`}>
                  <tr>
                    <td style={barCellStyle(item.type)} />
                    {!isFirstVersion && (
                      <td style={numCellStyle(item.type, item.type === "add")}>
                        {item.oldNum ?? ""}
                      </td>
                    )}
                    <td
                      style={{
                        ...numCellStyle(item.type, item.type === "remove"),
                        borderRight: "1px solid var(--border)",
                      }}
                    >
                      {item.newNum ?? ""}
                    </td>
                    <td
                      data-dline={item.idx}
                      style={contentCellStyle(item.type)}
                    >
                      {renderContent(item.idx)}
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
    key: string
  ) {
    if (!line) {
      return (
        <tr key={key}>
          <td
            style={{
              ...numCellStyle("context", true),
              background: "var(--bg)",
              borderRight: "1px solid var(--border)",
            }}
          />
          <td
            style={{ ...barCellStyle("context"), background: "var(--bg)" }}
          />
          <td
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

    return (
      <tr key={key}>
        <td
          style={{
            ...numCellStyle(line.type, hideNum),
            borderRight: "1px solid var(--border)",
          }}
        >
          {hideNum ? "" : (num ?? "")}
        </td>
        <td style={barCellStyle(line.type)} />
        <td
          data-dline={line.idx}
          style={contentCellStyle(line.type)}
        >
          {renderContent(line.idx)}
        </td>
      </tr>
    );
  }

  function renderSplit() {
    const sepIndices: number[] = [];
    let si = 0;
    for (const row of splitRows) {
      sepIndices.push(row.type === "separator" ? si++ : -1);
    }

    const splitRowComments = splitRows.map((row) => {
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
    });

    function renderColumn(side: "left" | "right") {
      return (
        <div data-split-side={side}>
          <table className="min-w-full border-separate border-spacing-0 font-[family-name:var(--font-mono)]">
            <tbody>
              {splitRows.map((row, i) => {
                if (row.type === "separator") {
                  return (
                    <tr key={`s${side}${i}`}>
                      {renderSeparatorTd(3, row.hiddenCount, sepIndices[i])}
                    </tr>
                  );
                }

                const line = side === "left" ? row.left : row.right;
                const comments = splitRowComments[i];

                return (
                  <Fragment key={`${side}${i}`}>
                    {renderSplitRow(line, side, `r${side}${i}`)}
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

    return (
      <div className="flex">
        <div className="shrink-0 basis-1/2 overflow-x-auto border-r border-[var(--border)] [container-type:inline-size]">
          {renderColumn("left")}
        </div>
        <div className="shrink-0 basis-1/2 overflow-x-auto [container-type:inline-size]">
          {renderColumn("right")}
        </div>
      </div>
    );
  }

  /* ── Main render ────────────────────────────────────────── */

  return (
    <div>
      {renderSettingsBar()}

      <div
        ref={contentRef}
        onMouseUp={handleMouseUp}
        className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]"
      >
        {effectiveViewMode === "unified" ? renderUnified() : renderSplit()}
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
            onRemoveAnnotation?.(editing.annotation.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
