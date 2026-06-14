import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@plan/shared/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { FileIcon } from "./file-icon";

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
  selected: { subPath: string; path: string; staged: boolean } | null;
  /** Project-relative path of the file of interest from another tab (e.g. a
   * file open in the Files tab) — highlighted distinctly from the selection. */
  activeFilePath?: string | null;
  onSelect: (subPath: string, path: string, staged: boolean) => void;
  onStage: (path: string, subPath: string) => void;
  onUnstage: (path: string, subPath: string) => void;
  onDiscard: (path: string, subPath: string) => void;
  /** Stage / unstage an entire section at once. */
  onStageAll: (subPath: string) => void;
  onUnstageAll: (subPath: string) => void;
  /** Repo-wide bulk actions on the Changes group. */
  onDiscardAll: (subPath: string) => void;
  onStashAll: (subPath: string) => void;
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
    case "?": // untracked — shown as "U", green like an addition (VSCode-style)
      return "text-[var(--diff-add-bar)]";
    case "D":
      return "text-[var(--diff-remove-bar)]";
    default:
      return "text-[var(--text-secondary)]";
  }
}

/** Git marks untracked files "?"; VSCode shows them as "U". */
function displayLetter(letter: FileEntry["letter"]): string {
  return letter === "?" ? "U" : letter;
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

/* ── Section-action icons (14px, currentColor) ──────────────── */

function svgProps() {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}
// Plus/minus span a wider extent (3→21) than a stock Lucide plus (5→19) so
// they read at the same optical size as the fuller archive/revert glyphs
// sitting next to them — otherwise the thin little +/- look undersized.
function PlusIcon() {
  return (
    <svg {...svgProps()}>
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}
function MinusIcon() {
  return (
    <svg {...svgProps()}>
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}
function DiscardIcon() {
  // rotate-ccw
  return (
    <svg {...svgProps()}>
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}
function StashIcon() {
  // archive box
  return (
    <svg {...svgProps()}>
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

/** Icon-only section action with a tooltip. */
function SectionIconButton({
  icon,
  tooltip,
  onClick,
  danger,
  accent,
}: {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          aria-label={tooltip}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface)]",
            danger && "hover:text-[var(--removed-text)]",
            accent && "hover:text-[var(--text)]",
            !danger && !accent && "hover:text-[var(--text-secondary)]"
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
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
        "flex h-6 w-6 items-center justify-center rounded-md font-[family-name:var(--font-mono)] text-[15px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface)]",
        danger && "hover:text-[var(--removed-text)]",
        accent && "hover:text-[var(--text)]",
        !danger && !accent && "hover:text-[var(--text-secondary)]"
      )}
    >
      {label}
    </button>
  );
}

export function FileList({
  groups,
  selected,
  activeFilePath,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onStashAll,
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
                <div className="flex shrink-0 items-center gap-1.5 pl-2">
                  {isStaged ? (
                    <SectionIconButton
                      icon={<MinusIcon />}
                      tooltip="Unstage all"
                      onClick={() => onUnstageAll(row.group.subPath)}
                    />
                  ) : (
                    <>
                      <SectionIconButton
                        icon={<StashIcon />}
                        tooltip="Stash all changes"
                        onClick={() => onStashAll(row.group.subPath)}
                      />
                      <SectionIconButton
                        icon={<DiscardIcon />}
                        tooltip="Discard all changes"
                        danger
                        onClick={() => onDiscardAll(row.group.subPath)}
                      />
                      <SectionIconButton
                        icon={<PlusIcon />}
                        tooltip="Stage all"
                        accent
                        onClick={() => onStageAll(row.group.subPath)}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          }

          const file = row.file;
          const isSelected =
            selected?.subPath === file.subPath &&
            selected?.path === file.path &&
            selected?.staged === file.staged;
          const projPath = file.subPath
            ? `${file.subPath}/${file.path}`
            : file.path;
          const isActive = !isSelected && projPath === activeFilePath;
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
                  : isActive
                    ? "border-l-[var(--accent)] bg-[var(--bg-surface)]"
                    : "border-l-transparent hover:bg-[var(--bg-surface-hover)]"
              )}
            >
              <button
                onClick={() => onSelect(file.subPath, file.path, file.staged)}
                title={file.subPath ? `${file.subPath}/${file.path}` : file.path}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-2 text-left"
              >
                <FileIcon name={basename} />
                <span className="shrink-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
                  {basename}
                </span>
                {dirname && (
                  <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    {dirname}
                  </span>
                )}
              </button>
              <span
                className={cn(
                  "shrink-0 px-1 text-center font-[family-name:var(--font-mono)] text-[11px] font-semibold",
                  statusColor(file.letter)
                )}
                title={file.letter === "?" ? "Untracked" : undefined}
              >
                {displayLetter(file.letter)}
              </span>
              <div className="flex items-center gap-1.5 pr-2 opacity-60 transition-opacity group-hover:opacity-100">
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
