import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@plan/shared/lib/utils";

export interface FileEntry {
  path: string;
  code?: string;
  letter: "A" | "M" | "D" | "R" | "?";
  additions?: number;
  deletions?: number;
  staged: boolean;
  /** Which repo this file belongs to (relative to the project's cwd). */
  subPath: string;
}

export interface RepoFileGroup {
  /** Empty string for the project-root repo, non-empty for nested repos. */
  subPath: string;
  /** Display name (e.g. "myapp" or "packages/api"). */
  repoName: string;
  staged: FileEntry[];
  unstaged: FileEntry[];
  diffAvailable: boolean;
}

interface Props {
  groups: RepoFileGroup[];
  selected: { subPath: string; path: string } | null;
  onSelect: (subPath: string, path: string) => void;
  onStage: (path: string, subPath: string) => void;
  onUnstage: (path: string, subPath: string) => void;
  onDiscard: (path: string, subPath: string) => void;
  /** Stage / unstage an entire section at once. */
  onStageAll: (subPath: string) => void;
  onUnstageAll: (subPath: string) => void;
}

const REPO_H = 34;
const SECTION_H = 30;
const FILE_H = 36;

type Row =
  | { kind: "repo"; key: string; group: RepoFileGroup }
  | {
      kind: "section";
      key: string;
      group: RepoFileGroup;
      section: "staged" | "unstaged";
    }
  | { kind: "file"; key: string; file: FileEntry };

function statusColor(letter: FileEntry["letter"]) {
  switch (letter) {
    case "A":
      return "text-[var(--diff-add-bar)]";
    case "D":
      return "text-[var(--diff-remove-bar)]";
    case "?":
      return "text-[var(--text-tertiary)]";
    default:
      return "text-[var(--text-secondary)]";
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 text-[9px] text-[var(--text-tertiary)] transition-transform",
        open && "rotate-90"
      )}
    >
      ▶
    </span>
  );
}

/** Small icon button for per-row stage/unstage/discard. */
function ActionButton({
  label,
  title,
  onClick,
  danger,
  accent,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border font-[family-name:var(--font-mono)] text-[16px] leading-none transition-colors",
        "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]",
        danger && "hover:border-[var(--removed-text)] hover:text-[var(--removed-text)]",
        accent && "hover:border-[var(--accent)] hover:text-[var(--text)]",
        !danger && !accent && "hover:text-[var(--text)]"
      )}
    >
      {label}
    </button>
  );
}

export function FileList({
  groups,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onStageAll,
  onUnstageAll,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Collapse state lives here so the whole list can be flattened + virtualized.
  // Default = everything open; we only track the *collapsed* keys.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set()
  );

  const nonEmpty = useMemo(
    () => groups.filter((g) => g.staged.length + g.unstaged.length > 0),
    [groups]
  );
  const multiRepo = nonEmpty.length > 1;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of nonEmpty) {
      const repoKey = g.subPath || "/";
      if (multiRepo) {
        out.push({ kind: "repo", key: `repo:${repoKey}`, group: g });
        if (collapsedRepos.has(repoKey)) continue;
      }
      const pushSection = (section: "staged" | "unstaged", files: FileEntry[]) => {
        if (files.length === 0) return;
        const sKey = `${repoKey}::${section}`;
        out.push({ kind: "section", key: `sec:${sKey}`, group: g, section });
        if (collapsedSections.has(sKey)) return;
        for (const f of files) {
          out.push({
            kind: "file",
            key: `file:${repoKey}:${section}:${f.path}`,
            file: f,
          });
        }
      };
      pushSection("staged", g.staged);
      pushSection("unstaged", g.unstaged);
    }
    return out;
  }, [nonEmpty, multiRepo, collapsedRepos, collapsedSections]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.kind === "repo") return REPO_H;
      if (r.kind === "section") return SECTION_H;
      return FILE_H;
    },
    overscan: 12,
  });

  if (nonEmpty.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No uncommitted changes
      </div>
    );
  }

  const toggleRepo = (key: string) =>
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div ref={parentRef} className="h-full min-h-0 overflow-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          const style: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: vi.size,
            transform: `translateY(${vi.start}px)`,
          };

          if (row.kind === "repo") {
            const repoKey = row.group.subPath || "/";
            const open = !collapsedRepos.has(repoKey);
            const total = row.group.staged.length + row.group.unstaged.length;
            return (
              <button
                key={row.key}
                style={style}
                onClick={() => toggleRepo(repoKey)}
                className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg-surface-hover)] px-3 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Chevron open={open} />
                  <span className="truncate font-semibold">
                    {row.group.repoName}
                  </span>
                </div>
                <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                  {total}
                </span>
              </button>
            );
          }

          if (row.kind === "section") {
            const repoKey = row.group.subPath || "/";
            const sKey = `${repoKey}::${row.section}`;
            const open = !collapsedSections.has(sKey);
            const isStaged = row.section === "staged";
            const files = isStaged ? row.group.staged : row.group.unstaged;
            return (
              <div
                key={row.key}
                style={style}
                className="group/section flex items-center justify-between border-b border-[var(--border)] pr-1.5 hover:bg-[var(--bg-surface-hover)]"
              >
                <button
                  onClick={() => toggleSection(sKey)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]"
                >
                  <Chevron open={open} />
                  <span className="truncate">
                    {isStaged ? "Staged Changes" : "Changes"}
                  </span>
                  <span>{files.length}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isStaged) onUnstageAll(row.group.subPath);
                    else onStageAll(row.group.subPath);
                  }}
                  title={isStaged ? "Unstage all" : "Stage all"}
                  className="flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 font-[family-name:var(--font-mono)] text-[11px] leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                >
                  <span className="text-[14px]">{isStaged ? "−" : "+"}</span>
                  <span>{isStaged ? "Unstage all" : "Stage all"}</span>
                </button>
              </div>
            );
          }

          const file = row.file;
          const isSelected =
            selected?.subPath === file.subPath && selected?.path === file.path;
          const basename = file.path.split("/").pop() ?? file.path;
          const dirname = file.path.includes("/")
            ? file.path.slice(0, file.path.lastIndexOf("/"))
            : "";
          return (
            <div
              key={row.key}
              style={style}
              className={cn(
                "group flex items-center border-l-2 transition-colors",
                isSelected
                  ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]"
                  : "border-l-transparent hover:bg-[var(--bg-surface-hover)]"
              )}
            >
              <button
                onClick={() => onSelect(file.subPath, file.path)}
                title={file.subPath ? `${file.subPath}/${file.path}` : file.path}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-2 text-left"
              >
                <span
                  className={cn(
                    "w-3 shrink-0 text-center font-[family-name:var(--font-mono)] text-[11px] font-semibold",
                    statusColor(file.letter)
                  )}
                >
                  {file.letter}
                </span>
                <span className="shrink-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
                  {basename}
                </span>
                {dirname && (
                  <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    {dirname}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1 pr-2 opacity-70 transition-opacity group-hover:opacity-100">
                {file.staged ? (
                  <ActionButton
                    label="−"
                    title="Unstage"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnstage(file.path, file.subPath);
                    }}
                  />
                ) : (
                  <>
                    <ActionButton
                      label="↺"
                      title="Discard changes"
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscard(file.path, file.subPath);
                      }}
                    />
                    <ActionButton
                      label="+"
                      title="Stage"
                      accent
                      onClick={(e) => {
                        e.stopPropagation();
                        onStage(file.path, file.subPath);
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
