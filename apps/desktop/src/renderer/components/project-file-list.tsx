import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@plan/shared/lib/utils";
import { FileIcon, FolderIcon } from "./file-icon";

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

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// ── Tree model ──────────────────────────────────────────────────────
interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileNode {
  type: "file";
  name: string;
  path: string;
}
type TreeNode = DirNode | FileNode;

function buildTree(files: string[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);
  for (const f of files) {
    const parts = f.split("/");
    let parent = root;
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      let dir = dirs.get(cur);
      if (!dir) {
        dir = { type: "dir", name: parts[i], path: cur, children: [] };
        dirs.set(cur, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({ type: "file", name: parts[parts.length - 1], path: f });
  }
  sortNodes(root);
  return root.children;
}

function sortNodes(dir: DirNode): void {
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.type === "dir") sortNodes(c);
}

interface Row {
  node: TreeNode;
  depth: number;
}
function flatten(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
  out: Row[] = []
): Row[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.type === "dir" && expanded.has(n.path)) {
      flatten(n.children, expanded, depth + 1, out);
    }
  }
  return out;
}

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

  const tree = useMemo(() => buildTree(files), [files]);

  // Reveal the selected (or cross-tab active) file by expanding its ancestors.
  const reveal = selected ?? activeFilePath ?? null;
  useEffect(() => {
    if (!reveal) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = reveal.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        next.add(cur);
      }
      return next;
    });
  }, [reveal]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? files.filter((f) => f.toLowerCase().includes(q)) : null),
    [files, q]
  );

  const rows: Row[] = useMemo(() => {
    if (filtered) {
      return filtered.map((f) => ({ node: { type: "file", name: f, path: f }, depth: 0 }));
    }
    return flatten(tree, expanded);
  }, [filtered, tree, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

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
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const { node, depth } = rows[vi.index];
              const isDir = node.type === "dir";
              const isOpen = isDir && expanded.has(node.path);
              const isSelected = node.type === "file" && node.path === selected;
              // Cross-tab indicator: the active file (e.g. an open diff) that
              // isn't the explicit selection here.
              const isActive =
                node.type === "file" &&
                !isSelected &&
                node.path === activeFilePath;
              return (
                <button
                  key={vi.key}
                  onClick={() => (isDir ? toggle(node.path) : onSelect(node.path))}
                  title={node.path}
                  className={cn(
                    "absolute left-0 top-0 flex w-full items-center gap-1 border-l-2 pr-2 text-left font-[family-name:var(--font-mono)] text-[12px] transition-colors",
                    isSelected
                      ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)] text-[var(--text)]"
                      : isActive
                        ? "border-l-[var(--accent)] bg-[var(--bg-surface)] text-[var(--text)]"
                        : "border-l-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
                  )}
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${vi.start}px)`,
                    paddingLeft: 8 + depth * 12,
                  }}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
                    {isDir ? <Chevron open={!!isOpen} /> : null}
                  </span>
                  {isDir ? (
                    <FolderIcon open={!!isOpen} />
                  ) : (
                    <FileIcon name={node.name} />
                  )}
                  <span className="truncate">
                    {filtered && node.type === "file" ? (
                      <>
                        <span>{basename(node.path)}</span>
                        {dirname(node.path) && (
                          <span className="ml-2 text-[10px] text-[var(--text-tertiary)]">
                            {dirname(node.path)}
                          </span>
                        )}
                      </>
                    ) : (
                      node.name
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("transition-transform", open && "rotate-90")}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
