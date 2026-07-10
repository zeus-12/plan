import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, toggleInSet } from "@plan/shared/lib/utils";
import { basename, dirname } from "@plan/shared/lib/path";
import type { SearchFileResult, SearchOptions } from "../../shared-types";
import { FileIcon } from "./file-icon";
import { Chevron } from "./chevron";

interface Props {
  encoded: string;
  /** True while the Search tab is the visible one — focuses the input. */
  active: boolean;
  /** Open a match: project-relative path + 1-based line + char range on it. */
  onOpenResult: (
    path: string,
    line: number,
    colStart: number,
    colEnd: number,
  ) => void;
}

const ROW_HEIGHT = 22;
const DEBOUNCE_MS = 200;
const PREVIEW_MAX = 400;

/** A flattened row in the virtualized results list. */
type Row =
  | { kind: "file"; file: SearchFileResult; matchCount: number }
  | {
      kind: "match";
      path: string;
      line: number;
      colStart: number;
      colEnd: number;
      preview: ReactNode;
    };

/** Trim leading indentation for display and shift the highlight ranges to match. */
function previewNodes(
  text: string,
  ranges: { start: number; end: number }[],
): ReactNode {
  const lead = text.length - text.trimStart().length;
  let display = text.slice(lead);
  if (display.length > PREVIEW_MAX) display = display.slice(0, PREVIEW_MAX);

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const s = Math.max(0, ranges[i].start - lead);
    const e = Math.max(0, ranges[i].end - lead);
    if (e <= cursor || s >= display.length) continue;
    if (s > cursor) parts.push(display.slice(cursor, s));
    parts.push(
      <mark
        key={i}
        className="rounded-[2px] bg-[var(--highlight-bg)] text-[var(--text)]"
      >
        {display.slice(Math.max(s, cursor), Math.min(e, display.length))}
      </mark>,
    );
    cursor = Math.min(e, display.length);
  }
  if (cursor < display.length) parts.push(display.slice(cursor));
  return <>{parts}</>;
}

/** Square toggle for the case / word / regex options (VS Code-style). */
function ToggleBtn({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] leading-none transition-colors",
        on
          ? "bg-[var(--accent)] text-[var(--bg)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
      )}
    >
      {children}
    </button>
  );
}

export function SearchPanel({ encoded, active, onOpenResult }: Props) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [files, setFiles] = useState<SearchFileResult[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each run is tagged so a slow earlier search can't overwrite a newer one.
  const runIdRef = useRef(0);

  const runSearch = useCallback(
    (q: string, o: SearchOptions) => {
      const trimmed = q;
      if (!trimmed) {
        runIdRef.current++;
        setFiles([]);
        setTotal(0);
        setTruncated(false);
        setError(null);
        setStatus("idle");
        return;
      }
      const id = ++runIdRef.current;
      setStatus("searching");
      if (typeof window.electronAPI.searchProjectFiles !== "function") {
        setError("Search unavailable — relaunch the app (stale build).");
        setStatus("done");
        return;
      }
      window.electronAPI
        .searchProjectFiles(encoded, trimmed, o)
        .then((res) => {
          if (id !== runIdRef.current) return; // a newer search superseded us
          setFiles(res.files);
          setTotal(res.totalMatches);
          setTruncated(res.truncated);
          setError(res.error ?? null);
          setCollapsed(new Set());
          setStatus("done");
        })
        .catch((err: unknown) => {
          if (id !== runIdRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(`Search failed: ${msg}`);
          setStatus("done");
        });
    },
    [encoded],
  );

  // Debounce query changes; option toggles re-run with the current query.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query, opts), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, opts, runSearch]);

  // Focus (and select) the box when the Search tab is opened.
  useEffect(() => {
    if (!active) return;
    const el = inputRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  const toggle = useCallback(
    (key: keyof SearchOptions) => setOpts((o) => ({ ...o, [key]: !o[key] })),
    [],
  );

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => toggleInSet(prev, path));
  }, []);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const file of files) {
      out.push({ kind: "file", file, matchCount: file.matches.length });
      if (collapsed.has(file.path)) continue;
      for (const m of file.matches) {
        out.push({
          kind: "match",
          path: file.path,
          line: m.line,
          colStart: m.ranges[0]?.start ?? 0,
          colEnd: m.ranges[0]?.end ?? 0,
          preview: previewNodes(m.text, m.ranges),
        });
      }
    }
    return out;
  }, [files, collapsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const summary = error
    ? error
    : status === "searching"
      ? "Searching…"
      : status === "idle"
        ? ""
        : total === 0
          ? "No results"
          : `${total} result${total === 1 ? "" : "s"} in ${files.length} file${
              files.length === 1 ? "" : "s"
            }${truncated ? " (showing first 5000)" : ""}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Query input + option toggles */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 focus-within:border-[var(--border-strong)]">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <ToggleBtn
            on={opts.caseSensitive}
            onClick={() => toggle("caseSensitive")}
            title="Match Case"
          >
            Aa
          </ToggleBtn>
          <ToggleBtn
            on={opts.wholeWord}
            onClick={() => toggle("wholeWord")}
            title="Match Whole Word"
          >
            <span className="underline">ab</span>
          </ToggleBtn>
          <ToggleBtn
            on={opts.regex}
            onClick={() => toggle("regex")}
            title="Use Regular Expression"
          >
            .*
          </ToggleBtn>
        </div>
        {summary && (
          <div
            className={cn(
              "mt-1.5 px-0.5 font-[family-name:var(--font-mono)] text-[10px]",
              error
                ? "text-[var(--removed-text)]"
                : "text-[var(--text-tertiary)]",
            )}
          >
            {summary}
          </div>
        )}
      </div>

      {/* Results */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            const style: React.CSSProperties = {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: ROW_HEIGHT,
              transform: `translateY(${vi.start}px)`,
            };
            if (row.kind === "file") {
              const isCollapsed = collapsed.has(row.file.path);
              return (
                <button
                  key={vi.key}
                  style={style}
                  onClick={() => toggleFile(row.file.path)}
                  className="flex items-center gap-1.5 px-2 text-left transition-colors hover:bg-[var(--bg-surface-hover)]"
                >
                  <Chevron
                    open={!isCollapsed}
                    className="text-[var(--text-tertiary)]"
                  />
                  <FileIcon name={basename(row.file.path)} />
                  <span className="truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
                    {basename(row.file.path)}
                  </span>
                  <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    {dirname(row.file.path)}
                  </span>
                  <span className="ml-auto shrink-0 rounded-full bg-[var(--bg-surface-hover)] px-1.5 text-[10px] text-[var(--text-tertiary)]">
                    {row.matchCount}
                  </span>
                </button>
              );
            }
            const key = `${row.path}:${row.line}:${row.colStart}`;
            return (
              <button
                key={vi.key}
                style={style}
                onClick={() => {
                  setSelected(key);
                  onOpenResult(row.path, row.line, row.colStart, row.colEnd);
                }}
                className={cn(
                  "flex items-center gap-2 py-0 pl-7 pr-2 text-left transition-colors",
                  selected === key
                    ? "bg-[var(--bg-surface-hover)]"
                    : "hover:bg-[var(--bg-surface-hover)]",
                )}
              >
                <span className="w-9 shrink-0 text-right font-[family-name:var(--font-mono)] text-[10px] tabular-nums text-[var(--text-tertiary)]">
                  {row.line}
                </span>
                <span className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
                  {row.preview}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
