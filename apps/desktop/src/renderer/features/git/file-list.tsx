import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, toggleInSet } from "@plan/shared/lib/utils";
import { basename, dirname } from "@plan/shared/lib/path";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { usePersistentString } from "./use-persistent-string";
import {
  buildFileTree,
  flattenFileTree,
} from "@/renderer/features/files/file-tree";
import { FileIcon, FolderIcon } from "@/renderer/components/file-icon";
import { Chevron } from "@/renderer/components/chevron";

type ViewMode = "list" | "tree";
const VIEW_MODES: readonly ViewMode[] = ["list", "tree"];

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
  /** Checked-out branch, if known (null on detached HEAD). */
  branch: string | null;
  staged: FileEntry[];
  unstaged: FileEntry[];
  diffAvailable: boolean;
}

interface Props {
  groups: RepoFileGroup[];
  /** Renders the commit box for a repo, shown above its staged changes. Owned by
   * the parent so the draft survives this virtualized row unmounting on scroll. */
  renderCommit?: (group: RepoFileGroup) => React.ReactNode;
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
const FOLDER_H = 32;
// Each tree nesting level adds this much left padding.
const INDENT = 12;
// Estimate only — commit rows are measured dynamically (resizable textarea).
const COMMIT_H = 104;

type Row =
  | { kind: "repo"; key: string; group: RepoFileGroup }
  | { kind: "commit"; key: string; group: RepoFileGroup }
  | {
      kind: "section";
      key: string;
      group: RepoFileGroup;
      section: "staged" | "unstaged";
    }
  | {
      kind: "folder";
      key: string;
      group: RepoFileGroup;
      section: "staged" | "unstaged";
      /** Repo-relative directory path — passed straight to git add/restore. */
      dirPath: string;
      /** Display label (single-child chains compacted, e.g. "src/main"). */
      name: string;
      depth: number;
      collapseKey: string;
    }
  | { kind: "file"; key: string; file: FileEntry; depth: number };

/**
 * Turn a section's flat file list into VSCode-style tree rows: folders (with
 * single-child chains compacted into one row, like `explorer.compactFolders`)
 * then files, sorted, depth-indented. Collapsed folders hide their descendants.
 */
function treeRows(
  group: RepoFileGroup,
  section: "staged" | "unstaged",
  files: FileEntry[],
  repoKey: string,
  collapsedFolders: Set<string>,
): Row[] {
  const keyFor = (dirPath: string) => `${repoKey}::${section}::dir::${dirPath}`;
  const tree = buildFileTree(files, (f) => f.path, { compact: true });
  return flattenFileTree(tree, (p) => !collapsedFolders.has(keyFor(p))).map(
    (row): Row =>
      row.kind === "dir"
        ? {
            kind: "folder",
            key: `fold:${keyFor(row.dir.path)}`,
            group,
            section,
            dirPath: row.dir.path,
            name: row.dir.name,
            depth: row.depth,
            collapseKey: keyFor(row.dir.path),
          }
        : {
            kind: "file",
            key: `file:${repoKey}:${section}:${row.file.path}`,
            file: row.file,
            depth: row.depth,
          },
  );
}

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

/* ── Section-action icons (14px, currentColor) ──────────────── */

function svgProps() {
  return {
    width: 13,
    height: 13,
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

function ListIcon() {
  return (
    <svg {...svgProps()}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}
function TreeIcon() {
  // list-tree
  return (
    <svg {...svgProps()}>
      <path d="M21 12h-8" />
      <path d="M21 6H8" />
      <path d="M21 18h-8" />
      <path d="M3 6v4c0 1.1.9 2 2 2h3" />
      <path d="M3 10v6c0 1.1.9 2 2 2h3" />
    </svg>
  );
}

/** Compact two-button segmented control switching the file list view mode. */
function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const seg = (m: ViewMode, label: string, icon: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange(m);
          }}
          aria-label={label}
          aria-pressed={mode === m}
          className={cn(
            "flex h-[18px] w-[22px] items-center justify-center rounded-[4px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
            mode === m
              ? "bg-[var(--bg-surface-hover)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="mr-1 flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-0.5">
      {seg("list", "View as list", <ListIcon />)}
      {seg("tree", "View as tree", <TreeIcon />)}
    </div>
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
            "flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface)]",
            danger && "hover:text-[var(--removed-text)]",
            accent && "hover:text-[var(--text)]",
            !danger && !accent && "hover:text-[var(--text-secondary)]",
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
  icon,
  title,
  onClick,
  danger,
  accent,
}: {
  icon: React.ReactNode;
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
        "flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface)]",
        danger && "hover:text-[var(--removed-text)]",
        accent && "hover:text-[var(--text)]",
        !danger && !accent && "hover:text-[var(--text-secondary)]",
      )}
    >
      {icon}
    </button>
  );
}

export function FileList({
  groups,
  renderCommit,
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
    new Set(),
  );
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [viewMode, setViewMode] = usePersistentString<ViewMode>(
    "plan.diffs.viewMode",
    "list",
    VIEW_MODES,
  );

  const nonEmpty = useMemo(
    () => groups.filter((g) => g.staged.length + g.unstaged.length > 0),
    [groups],
  );
  const multiRepo = nonEmpty.length > 1;
  const hasCommit = !!renderCommit;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of nonEmpty) {
      const repoKey = g.subPath || "/";
      if (multiRepo) {
        out.push({ kind: "repo", key: `repo:${repoKey}`, group: g });
        if (collapsedRepos.has(repoKey)) continue;
      }
      // Commit box sits directly above this repo's staged changes.
      if (hasCommit && g.staged.length > 0) {
        out.push({ kind: "commit", key: `commit:${repoKey}`, group: g });
      }
      const pushSection = (
        section: "staged" | "unstaged",
        files: FileEntry[],
      ) => {
        if (files.length === 0) return;
        const sKey = `${repoKey}::${section}`;
        out.push({ kind: "section", key: `sec:${sKey}`, group: g, section });
        if (collapsedSections.has(sKey)) return;
        if (viewMode === "tree") {
          out.push(...treeRows(g, section, files, repoKey, collapsedFolders));
        } else {
          for (const f of files) {
            out.push({
              kind: "file",
              key: `file:${repoKey}:${section}:${f.path}`,
              file: f,
              depth: 0,
            });
          }
        }
      };
      pushSection("staged", g.staged);
      pushSection("unstaged", g.unstaged);
    }
    return out;
  }, [
    nonEmpty,
    multiRepo,
    hasCommit,
    collapsedRepos,
    collapsedSections,
    collapsedFolders,
    viewMode,
  ]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Key measurements by stable row identity, not index. The commit row is
    // dynamically measured (~104px); without this, when it disappears (staged
    // count → 0 after a commit) its cached height bleeds onto whatever row
    // slides into its old index — bloating the Changes header.
    getItemKey: (i) => rows[i].key,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.kind === "repo") return REPO_H;
      if (r.kind === "commit") return COMMIT_H;
      if (r.kind === "section") return SECTION_H;
      if (r.kind === "folder") return FOLDER_H;
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
    setCollapsedRepos((prev) => toggleInSet(prev, key));
  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => toggleInSet(prev, key));
  const toggleFolder = (key: string) =>
    setCollapsedFolders((prev) => toggleInSet(prev, key));

  return (
    <div ref={parentRef} className="h-full min-h-0 overflow-auto">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
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

          if (row.kind === "commit") {
            // Measured (not fixed height) so the resizable textarea reflows.
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {renderCommit?.(row.group)}
              </div>
            );
          }

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
                  <Chevron
                    open={open}
                    className="text-[var(--text-tertiary)]"
                  />
                  <span className="truncate font-semibold">
                    {row.group.repoName}
                  </span>
                  {/* Same bordered pill as the workspace header; truncates
                      well before the repo name does. */}
                  {row.group.branch && (
                    <span className="min-w-0 shrink-[4] truncate rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--text-secondary)]">
                      {row.group.branch}
                    </span>
                  )}
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
                  <Chevron
                    open={open}
                    className="text-[var(--text-tertiary)]"
                  />
                  <span className="truncate">
                    {isStaged ? "Staged Changes" : "Changes"}
                  </span>
                  <span>{files.length}</span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 pl-2">
                  <ViewModeToggle mode={viewMode} onChange={setViewMode} />
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

          if (row.kind === "folder") {
            const open = !collapsedFolders.has(row.collapseKey);
            const isStaged = row.section === "staged";
            return (
              <div
                key={row.key}
                style={style}
                className="group/folder flex items-center border-l-2 border-l-transparent transition-colors hover:bg-[var(--bg-surface-hover)]"
              >
                <button
                  onClick={() => toggleFolder(row.collapseKey)}
                  title={row.dirPath}
                  style={{ paddingLeft: INDENT + row.depth * INDENT }}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
                >
                  <Chevron
                    open={open}
                    className="text-[var(--text-tertiary)]"
                  />
                  <FolderIcon open={open} />
                  <span className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
                    {row.name}
                  </span>
                </button>
                <div className="flex items-center gap-0.5 pl-1.5 pr-2 opacity-0 transition-opacity group-hover/folder:opacity-100">
                  {isStaged ? (
                    <ActionButton
                      icon={<MinusIcon />}
                      title="Unstage folder"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnstage(row.dirPath, row.group.subPath);
                      }}
                    />
                  ) : (
                    <ActionButton
                      icon={<PlusIcon />}
                      title="Stage folder"
                      accent
                      onClick={(e) => {
                        e.stopPropagation();
                        onStage(row.dirPath, row.group.subPath);
                      }}
                    />
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
          const fileBasename = basename(file.path);
          const fileDirname = dirname(file.path);
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
                    : "border-l-transparent hover:bg-[var(--bg-surface-hover)]",
              )}
            >
              <button
                onClick={() => onSelect(file.subPath, file.path, file.staged)}
                title={
                  file.subPath ? `${file.subPath}/${file.path}` : file.path
                }
                style={{ paddingLeft: INDENT + row.depth * INDENT }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2 text-left"
              >
                {/* Reserve the folder's chevron column so a file's icon aligns
                    under its parent folder icon — since files sit one depth
                    deeper, this nests them clearly beneath the folder. */}
                {viewMode === "tree" && (
                  <span aria-hidden className="w-2 shrink-0" />
                )}
                <FileIcon name={fileBasename} />
                <span className="min-w-0 shrink truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
                  {fileBasename}
                </span>
                {viewMode === "list" && fileDirname && (
                  <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    {fileDirname}
                  </span>
                )}
              </button>
              <span
                className={cn(
                  "shrink-0 pl-1 text-center font-[family-name:var(--font-mono)] text-[11px] font-semibold",
                  statusColor(file.letter),
                )}
                title={file.letter === "?" ? "Untracked" : undefined}
              >
                {displayLetter(file.letter)}
              </span>
              <div className="flex items-center gap-0.5 pl-1.5 pr-2 opacity-60 transition-opacity group-hover:opacity-100">
                {file.staged ? (
                  <ActionButton
                    icon={<MinusIcon />}
                    title="Unstage"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnstage(file.path, file.subPath);
                    }}
                  />
                ) : (
                  <>
                    <ActionButton
                      icon={<DiscardIcon />}
                      title="Discard changes"
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscard(file.path, file.subPath);
                      }}
                    />
                    <ActionButton
                      icon={<PlusIcon />}
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
