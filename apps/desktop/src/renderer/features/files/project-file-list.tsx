import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, toggleInSet } from "@plan/shared/lib/utils";
import { basename, dirname } from "@plan/shared/lib/path";
import { FileIcon, FolderIcon } from "@/renderer/components/file-icon";
import {
  ancestorDirs,
  buildFileTree,
  flattenFileTree,
  type FileTreeRow,
} from "./file-tree";
import { Chevron } from "@/renderer/components/chevron";

interface Props {
  files: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  loading: boolean;
  /** The file of interest from another tab (e.g. an open diff) — highlighted
   * distinctly from the explicit selection so it's locatable across tabs. */
  activeFilePath?: string | null;
}

const ROW_HEIGHT = 24;

type Row = FileTreeRow<string>;

/**
 * VSCode-style collapsible file tree. While a filter query is typed it flattens
 * to a plain match list (instant), otherwise it shows the tree. Visible rows are
 * virtualized so even huge trees stay smooth.
 */
export function ProjectFileList({
  files,
  selected,
  onSelect,
  loading,
  activeFilePath,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildFileTree(files, (f) => f), [files]);

  // Reveal the selected (or cross-tab active) file by expanding its ancestors.
  const reveal = selected ?? activeFilePath ?? null;
  useEffect(() => {
    if (!reveal) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of ancestorDirs(reveal)) next.add(dir);
      return next;
    });
  }, [reveal]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? files.filter((f) => f.toLowerCase().includes(q)) : null),
    [files, q],
  );

  const rows: Row[] = useMemo(() => {
    if (filtered) {
      return filtered.map((f) => ({
        kind: "file" as const,
        file: f,
        depth: 0,
      }));
    }
    return flattenFileTree(tree, (p) => expanded.has(p));
  }, [filtered, tree, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const toggle = (path: string) =>
    setExpanded((prev) => toggleInSet(prev, path));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter files…"
          className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:border-[var(--border-strong)]"
        />
      </div>
      {loading ? (
        <Centered>Indexing…</Centered>
      ) : rows.length === 0 ? (
        <Centered>{files.length === 0 ? "No files" : "No matches"}</Centered>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const { depth } = row;
              const isDir = row.kind === "dir";
              const path = isDir ? row.dir.path : row.file;
              const name = isDir ? row.dir.name : basename(row.file);
              const isOpen = isDir && expanded.has(path);
              const isSelected = !isDir && path === selected;
              // Cross-tab indicator: the active file (e.g. an open diff) that
              // isn't the explicit selection here.
              const isActive = !isDir && !isSelected && path === activeFilePath;
              return (
                <button
                  key={vi.key}
                  onClick={() => (isDir ? toggle(path) : onSelect(path))}
                  title={path}
                  className={cn(
                    "absolute left-0 top-0 flex w-full items-center gap-1 border-l-2 pr-2 text-left font-[family-name:var(--font-mono)] text-[12px] transition-colors",
                    isSelected
                      ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)] text-[var(--text)]"
                      : isActive
                        ? "border-l-[var(--accent)] bg-[var(--bg-surface)] text-[var(--text)]"
                        : "border-l-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]",
                  )}
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${vi.start}px)`,
                    paddingLeft: 8 + depth * 12,
                  }}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
                    {isDir ? (
                      <Chevron open={!!isOpen} size={9} strokeWidth={3} />
                    ) : null}
                  </span>
                  {isDir ? (
                    <FolderIcon open={!!isOpen} />
                  ) : (
                    <FileIcon name={name} />
                  )}
                  <span className="truncate">
                    {filtered && !isDir ? (
                      <>
                        <span>{name}</span>
                        {dirname(path) && (
                          <span className="ml-2 text-[10px] text-[var(--text-tertiary)]">
                            {dirname(path)}
                          </span>
                        )}
                      </>
                    ) : (
                      name
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
