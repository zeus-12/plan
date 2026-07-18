import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  buildDiffLines,
  buildSplitRows,
  type DiffLine,
} from "@plan/shared/lib/diff";
import {
  highlightPerLine,
  languageFromPath,
  useShikiReady,
  type SyntaxToken,
} from "@plan/shared/lib/highlight";
import { basename } from "@plan/shared/lib/path";

/**
 * What a tool call is worth previewing on hover: an Edit/MultiEdit becomes a
 * before/after diff, a Write becomes the created file's contents. Everything
 * else returns null (the header already says enough). The diff/content is built
 * purely from the tool input — we never read the file on disk.
 */
export type ToolPreview =
  | {
      kind: "diff";
      path: string;
      language: string;
      edits: { oldText: string; newText: string }[];
    }
  | { kind: "content"; path: string; language: string; content: string };

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function toolPreview(tool: string, input: unknown): ToolPreview | null {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : null;
  if (!obj) return null;
  const path = asStr(obj.file_path);
  const language = (path && languageFromPath(path)) || "plaintext";

  switch (tool) {
    case "Edit": {
      const oldText = asStr(obj.old_string);
      const newText = asStr(obj.new_string);
      if (!oldText && !newText) return null;
      return { kind: "diff", path, language, edits: [{ oldText, newText }] };
    }
    case "MultiEdit": {
      const raw = Array.isArray(obj.edits) ? obj.edits : [];
      const edits = raw
        .map((e) =>
          e && typeof e === "object" ? (e as Record<string, unknown>) : null,
        )
        .filter((e): e is Record<string, unknown> => e != null)
        .map((e) => ({
          oldText: asStr(e.old_string),
          newText: asStr(e.new_string),
        }))
        .filter((e) => e.oldText || e.newText);
      if (!edits.length) return null;
      return { kind: "diff", path, language, edits };
    }
    case "Write": {
      const content = asStr(obj.content);
      if (!content) return null;
      return { kind: "content", path, language, content };
    }
    default:
      return null;
  }
}

// Fixed presentation — no user tweaking. A split (two-panel) diff needs more
// room than the single-panel new-file view; both wrap long lines rather than
// scroll horizontally.
const CARD_WIDTH_DIFF = 720;
const CARD_WIDTH_CONTENT = 560;

/** Split one line's text into coloured spans from its Shiki tokens. */
function TokenizedLine({
  text,
  tokens,
}: {
  text: string;
  tokens: SyntaxToken[];
}): ReactNode {
  if (!text) return " "; // keep empty lines at full row height
  if (!tokens.length) return text;
  const spans: ReactNode[] = [];
  let pos = 0;
  tokens.forEach((t, i) => {
    if (t.start > pos) spans.push(text.slice(pos, t.start));
    const style: CSSProperties = {};
    if (t.color) style.color = t.color;
    if (t.italic) style.fontStyle = "italic";
    if (t.bold) style.fontWeight = 600;
    spans.push(
      <span key={i} className={t.className} style={style}>
        {text.slice(t.start, t.end)}
      </span>,
    );
    pos = t.end;
  });
  if (pos < text.length) spans.push(text.slice(pos));
  return spans;
}

function rowStyle(type: DiffLine["type"]): CSSProperties {
  if (type === "add") return { background: "var(--diff-add-bg)" };
  if (type === "remove") return { background: "var(--diff-remove-bg)" };
  return {};
}

function sign(type: DiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "remove") return "-";
  return " ";
}

function signColor(type: DiffLine["type"]): string {
  if (type === "add") return "var(--diff-add-bar)";
  if (type === "remove") return "var(--diff-remove-bar)";
  return "var(--text-tertiary)";
}

/** One side of a split-diff row: sign gutter + wrapped, coloured content. An
 *  absent line (no counterpart on this side) renders as a muted filler cell. */
function SplitCell({
  line,
  tokens,
  border,
}: {
  line: DiffLine | undefined;
  tokens: SyntaxToken[];
  border?: boolean;
}) {
  return (
    <div
      className={`flex w-1/2 min-w-0${border ? " border-l border-[var(--border)]" : ""}`}
      style={line ? rowStyle(line.type) : { background: "var(--bg-surface)" }}
    >
      {line ? (
        <>
          <span
            className="w-4 shrink-0 select-none text-center"
            style={{ color: signColor(line.type) }}
          >
            {sign(line.type)}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">
            <TokenizedLine text={line.content} tokens={tokens} />
          </span>
        </>
      ) : null}
    </div>
  );
}

/** A single edit rendered as a two-panel (old | new), syntax-highlighted diff. */
function DiffSection({
  oldText,
  newText,
  language,
  shikiReady,
}: {
  oldText: string;
  newText: string;
  language: string;
  shikiReady: number;
}) {
  const rows = useMemo(
    () => buildSplitRows(buildDiffLines(oldText, newText)),
    [oldText, newText],
  );
  // Tokens are keyed to each side's own text, then matched back by line number
  // so colours line up exactly with content on either panel.
  const [oldPer, newPer] = useMemo(
    () => [
      highlightPerLine(oldText, language),
      highlightPerLine(newText, language),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oldText, newText, language, shikiReady],
  );

  return (
    <div>
      {rows.map((row, i) => {
        if (row.type === "separator") return null;
        const { left, right } = row;
        return (
          <div key={i} className="flex">
            <SplitCell
              line={left}
              tokens={left ? (oldPer[(left.oldNum ?? 0) - 1] ?? []) : []}
            />
            <SplitCell
              line={right}
              tokens={right ? (newPer[(right.newNum ?? 0) - 1] ?? []) : []}
              border
            />
          </div>
        );
      })}
    </div>
  );
}

/** Highlighted contents of a newly written file. */
function ContentSection({
  content,
  language,
  shikiReady,
}: {
  content: string;
  language: string;
  shikiReady: number;
}) {
  const perLine = useMemo(
    () => highlightPerLine(content, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, language, shikiReady],
  );
  const lines = useMemo(() => {
    const arr = content.split("\n");
    if (arr.at(-1) === "") arr.pop();
    return arr;
  }, [content]);

  return (
    <div>
      {lines.map((line, i) => (
        <div key={i} className="flex" style={{ background: "var(--diff-add-bg)" }}>
          <span
            className="w-4 shrink-0 select-none text-center"
            style={{ color: "var(--diff-add-bar)" }}
          >
            +
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3">
            <TokenizedLine text={line} tokens={perLine[i] ?? []} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A fixed, portalled hover card showing what a tool call changed — a diff for
 * Edits, the new contents for Writes. It positions itself below the anchor,
 * flipping above when there isn't room, and stays open while the pointer is over
 * it (the parent wires onMouseEnter/onMouseLeave to a shared hover timer).
 */
export function ToolPreviewCard({
  preview,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: {
  preview: ToolPreview;
  anchor: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const shikiReady = useShikiReady();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({
    top: 0,
    left: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - 8) {
      const above = anchor.top - 6 - h;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h);
    }
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    setPos({ top, left, visibility: "visible" });
  }, [anchor, preview]);

  const name = preview.path ? basename(preview.path) : "";
  const label = preview.kind === "content" ? "new file" : "diff";

  return (
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)] shadow-lg"
      style={{
        ...pos,
        width: preview.kind === "diff" ? CARD_WIDTH_DIFF : CARD_WIDTH_CONTENT,
        maxWidth: "calc(100vw - 16px)",
      }}
    >
      <div className="flex items-baseline gap-2 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)]">
        <span className="truncate text-[11px] text-[var(--text-secondary)]">
          {name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
      <div className="max-h-[60vh] overflow-auto py-1.5 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
        {preview.kind === "diff"
          ? preview.edits.map((e, i) => (
              <div
                key={i}
                className={
                  i > 0 ? "mt-1.5 border-t border-[var(--border)] pt-1.5" : ""
                }
              >
                <DiffSection
                  oldText={e.oldText}
                  newText={e.newText}
                  language={preview.language}
                  shikiReady={shikiReady}
                />
              </div>
            ))
          : (
            <ContentSection
              content={preview.content}
              language={preview.language}
              shikiReady={shikiReady}
            />
          )}
      </div>
    </div>
  );
}

/**
 * Hover-intent state for a tool preview: open after a short dwell on the chip,
 * stay open while the pointer is on the chip or the card, close shortly after it
 * leaves both. Mirrors the blame-card timing pattern.
 */
export function useToolPreviewHover() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);

  const onEnter = useCallback(
    (rect: DOMRect) => {
      clear();
      timer.current = window.setTimeout(() => setAnchor(rect), 300);
    },
    [clear],
  );
  const onLeave = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setAnchor(null), 180);
  }, [clear]);
  const onCardEnter = clear;
  const onCardLeave = onLeave;

  return { anchor, onEnter, onLeave, onCardEnter, onCardLeave };
}
