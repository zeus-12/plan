import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  highlightPerLine,
  languageFromPath,
  useShikiReady,
  type SyntaxToken,
} from "@plan/shared/lib/highlight";
import type { Annotation } from "@plan/shared/lib/store";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { useSelectionCommit } from "@plan/shared/lib/use-selection-commit";
import { cn } from "@plan/shared/lib/utils";
import { FileIcon } from "./file-icon";

const LINE_HEIGHT = 20;

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
}

interface Loaded {
  text: string;
  truncated: boolean;
  binary: boolean;
}

interface PendingComment {
  text: string;
  startLine: number;
  endLine: number;
  top: number;
  left: number;
}

interface EditingComment {
  id: string;
  selectedText: string;
  comment: string;
  top: number;
  left: number;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Tokens carry dual light/dark colors; the global `.shiki-tok` rule picks one. */
function lineNodes(line: string, tokens: SyntaxToken[] | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return line.length ? line : " ";
  const out: ReactNode[] = [];
  let cur = 0;
  tokens.forEach((t, i) => {
    if (t.start > cur) out.push(line.slice(cur, t.start));
    const style: Record<string, string | number> = {};
    if (t.lightColor) style["--shiki-light"] = t.lightColor;
    if (t.darkColor) style["--shiki-dark"] = t.darkColor;
    if (t.italic) style.fontStyle = "italic";
    if (t.bold) style.fontWeight = 600;
    out.push(
      <span
        key={i}
        className={t.lightColor || t.darkColor ? "shiki-tok" : undefined}
        style={style as React.CSSProperties}
      >
        {line.slice(t.start, t.end)}
      </span>
    );
    cur = t.end;
  });
  if (cur < line.length) out.push(line.slice(cur));
  return out;
}

export function FileViewer({
  encoded,
  path,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  active,
}: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">("loading");
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [editing, setEditing] = useState<EditingComment | null>(null);
  const shikiReady = useShikiReady();
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
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
  }, [encoded, path]);

  const language = useMemo(() => languageFromPath(path) ?? "plaintext", [path]);
  const lines = useMemo(() => (data?.text ?? "").split("\n"), [data?.text]);
  const perLine = useMemo(
    () =>
      data && !data.binary ? highlightPerLine(data.text, language) : [],
    // shikiReady is a dep so colors appear once the highlighter finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, language, shikiReady]
  );

  // Character offset where each line begins — lets a line range map back to the
  // offsets the Annotation shape stores.
  const lineStarts = useMemo(() => {
    const arr = new Array<number>(lines.length);
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      arr[i] = acc;
      acc += lines[i].length + 1;
    }
    return arr;
  }, [lines]);

  // Lines covered by a comment (for tinting) + the comment anchored at each
  // line's first row (for the clickable gutter marker).
  const { covered, firstOf } = useMemo(() => {
    const covered = new Set<number>();
    const firstOf = new Map<number, Annotation>();
    for (const an of annotations) {
      const s = an.context?.startLine;
      if (!s) continue;
      const e = an.context?.endLine ?? s;
      for (let ln = s; ln <= e; ln++) covered.add(ln);
      if (!firstOf.has(s)) firstOf.set(s, an);
    }
    return { covered, firstOf };
  }, [annotations]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  const gutterCh = Math.max(2, String(lines.length).length) + 1;

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

  const handleSelection = useCallback(() => {
    const root = parentRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Only act when the whole selection lives inside this viewer.
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    )
      return;
    const text = sel.toString();
    if (!text.trim()) return;
    const a = lineIndexOf(range.startContainer);
    const b = lineIndexOf(range.endContainer);
    if (a == null || b == null) return;
    const rect = range.getBoundingClientRect();
    setEditing(null);
    setPending({
      text,
      startLine: Math.min(a, b) + 1,
      endLine: Math.max(a, b) + 1,
      top: rect.bottom + 8,
      left: rect.left,
    });
  }, [lineIndexOf]);

  useSelectionCommit(handleSelection, active && status === "ok");

  const submitNew = useCallback(
    (comment: string) => {
      if (!pending) return;
      const startOffset = lineStarts[pending.startLine - 1] ?? 0;
      const endIdx = pending.endLine - 1;
      const endOffset = (lineStarts[endIdx] ?? 0) + (lines[endIdx]?.length ?? 0);
      onAddAnnotation(
        pending.text,
        startOffset,
        endOffset,
        pending.startLine,
        pending.endLine,
        comment
      );
      setPending(null);
      window.getSelection()?.removeAllRanges();
    },
    [pending, lineStarts, lines, onAddAnnotation]
  );

  const openEditor = useCallback(
    (an: Annotation, e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPending(null);
      setEditing({
        id: an.id,
        selectedText: an.selectedText,
        comment: an.comment,
        top: rect.bottom + 8,
        left: rect.left,
      });
    },
    []
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
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
      ) : data?.binary ? (
        <Centered>Binary file — can&apos;t preview</Centered>
      ) : (
        <div
          ref={parentRef}
          className="min-h-0 flex-1 overflow-auto font-[family-name:var(--font-mono)] text-[13px] leading-[20px]"
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
              const lineNo = vi.index + 1;
              const isCovered = covered.has(lineNo);
              const anchored = firstOf.get(lineNo);
              return (
                <div
                  key={vi.key}
                  data-line-index={vi.index}
                  className={cn(
                    "absolute left-0 top-0 flex w-full",
                    isCovered && "bg-[var(--bg-surface)]"
                  )}
                  style={{ height: LINE_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <span
                    className="sticky left-0 z-10 flex shrink-0 select-none items-center justify-end gap-1 bg-[var(--bg)] pr-3 pl-3 text-right text-[var(--text-tertiary)]"
                    style={{ width: `${gutterCh + 2}ch` }}
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
                  <span className="select-text whitespace-pre pl-3 pr-6 text-[var(--text)] [cursor:text]">
                    {lineNodes(line, perLine[vi.index])}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pending && (
        <CommentPopover
          position={{ top: pending.top, left: pending.left }}
          selectedText={pending.text}
          onSubmit={submitNew}
          onClose={() => setPending(null)}
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
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
