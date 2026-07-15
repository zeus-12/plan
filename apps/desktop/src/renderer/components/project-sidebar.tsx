import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  GitBranch,
  Plus,
  Settings as SettingsGear,
} from "lucide-react";
import { cn, toggleInSet } from "@plan/shared/lib/utils";
import { lastSegment } from "@plan/shared/lib/path";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import { usePersistentNumber } from "../lib/use-persistent-number";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@plan/shared/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@plan/shared/components/ui/alert-dialog";
import type {
  DiscoveredRepo,
  ProjectEntry,
  WorktreeRecord,
} from "../../shared-types";
import { relativeTime } from "../lib/time";
import {
  buildProjectTree,
  flattenTree,
  type VisibleItem,
} from "../lib/project-tree";
import { useApprovalEncodedSet } from "../lib/session-approval-store";
import { useUnreadEncodedSet } from "../lib/unread-response-store";
import { useWorkingEncodedSet } from "../lib/terminal-activity-store";
import { StatusDots } from "./status-dots";
import { ChevronLeft } from "./chevron";

interface Props {
  projects: ProjectEntry[];
  reposByProject: Map<string, DiscoveredRepo[]>;
  /** file:// icon URL per project (repo favicon / GitHub avatar); absent = none. */
  iconsByProject: Map<string, string>;
  /** Each project's worktrees, keyed by the project's encoded cwd. */
  worktreesByProject: Map<string, WorktreeRecord[]>;
  /** The selected project's encoded cwd (the live working copy's project). */
  selectedProject: string | null;
  /** The active worktree within the selected project; null = live copy. */
  activeWorktreeId: string | null;
  /** Select a project's live working copy. */
  onSelectProject: (encoded: string) => void;
  /** Select a worktree within a project. */
  onSelectWorktree: (projectEncoded: string, worktreeId: string) => void;
  /** Create a new worktree in the given project. */
  onNewWorktree: (projectEncoded: string) => void;
  /** Open the worktree-creation defaults for the given project. */
  onOpenProjectDefaults: (projectEncoded: string) => void;
  onRemoveWorktree: (worktreeId: string) => void;
  onCreatePr: (worktreeId: string) => void;
  onAddRepos: (worktreeId: string) => void;
  onAddProject: () => void;
  onSetArchived: (encoded: string, archived: boolean) => Promise<void> | void;
  onOpenDashboard: () => void;
  onOpenSettings: () => void;
  /** Open the global ~/.claude/CLAUDE.md (and the rest of the config tree). */
  onOpenClaudeConfig: () => void;
}

const LEAF_HEIGHT = 50;
const WORKTREE_HEIGHT = 34;
const GROUP_HEIGHT = 36;
// Empty space above each top-level entry (project / group header) so one
// project's block — itself plus its nested worktrees — reads as separate from
// the next. Rendered as transparent padding above the row, never highlighted.
const GROUP_GAP = 6;
const EXPANDED_STORAGE = "plan.projectSidebar.expandedGroups";

function loadExpanded(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function persistExpanded(s: Set<string>) {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

type Row = VisibleItem;

/** Panel-left glyph — toggles the projects (1st) sidebar. */
function GaugeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PanelLeftIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

/** Globe — the global ~/.claude/CLAUDE.md (machine-wide instructions). */
function GlobeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/**
 * Project icon: the resolved image when we have one, else a letter tile.
 * A broken image (stale cache file, deleted favicon) falls back to the tile
 * rather than showing the browser's broken-image glyph.
 */
function ProjectIcon({ url, name }: { url: string | undefined; name: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[var(--border)] font-[family-name:var(--font-mono)] text-[9px] leading-none text-[var(--text-tertiary)]">
        {(name[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailedUrl(url)}
      className="h-4 w-4 shrink-0 rounded object-cover"
    />
  );
}

export function ProjectSidebar({
  projects,
  reposByProject,
  iconsByProject,
  worktreesByProject,
  selectedProject,
  activeWorktreeId,
  onSelectProject,
  onSelectWorktree,
  onNewWorktree,
  onOpenProjectDefaults,
  onRemoveWorktree,
  onCreatePr,
  onAddRepos,
  onAddProject,
  onSetArchived,
  onOpenDashboard,
  onOpenSettings,
  onOpenClaudeConfig,
}: Props) {
  const sidebar = useSidebar();
  const selected = selectedProject;
  // Pick a representative branch per project: first repo's branch.
  // (Multi-repo projects don't worktree-group, so this is the right label.)
  const branches = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [enc, repos] of reposByProject) {
      map.set(enc, repos[0]?.branch ?? null);
    }
    return map;
  }, [reposByProject]);
  // Target cwds (projects + worktrees) with a session parked on a menu. Rolled
  // up onto rows below so a waiting session in a collapsed project/worktree
  // still surfaces on the sidebar without expanding it.
  const approvalEncoded = useApprovalEncodedSet();
  const unreadEncoded = useUnreadEncodedSet();
  const workingEncoded = useWorkingEncodedSet();
  const parentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());
  // When true the sidebar transforms into an archived-only view.
  const [archivedView, setArchivedView] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: "archive"; project: ProjectEntry }
    | { kind: "unarchive"; project: ProjectEntry }
    | null
  >(null);

  const { active, archived } = useMemo(() => {
    const a: ProjectEntry[] = [];
    const ar: ProjectEntry[] = [];
    for (const p of projects) {
      if (p.archived) ar.push(p);
      else a.push(p);
    }
    // Most recently active project first (new message bumps it to the top).
    a.sort((x, y) => y.mtimeMs - x.mtimeMs);
    return { active: a, archived: ar };
  }, [projects]);

  const tree = useMemo(
    () => buildProjectTree(active, reposByProject),
    [active, reposByProject],
  );

  // Auto-expand so the active selection is visible: the group containing the
  // selected project, and the project itself when a worktree of it is active.
  useEffect(() => {
    if (!selected) return;
    const toAdd: string[] = [];
    if (activeWorktreeId && !expanded.has(selected)) toAdd.push(selected);
    for (const n of tree) {
      if (n.kind !== "group") continue;
      if (
        n.children.some((c) => c.encoded === selected) &&
        !expanded.has(n.key)
      )
        toAdd.push(n.key);
    }
    if (toAdd.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of toAdd) next.add(k);
      persistExpanded(next);
      return next;
    });
  }, [selected, activeWorktreeId, tree, expanded]);

  // Leave the archived view automatically once it's empty (e.g. last unarchive).
  useEffect(() => {
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length]);

  const rows: Row[] = useMemo(() => {
    if (archivedView) {
      return archived.map((p) => ({
        kind: "project" as const,
        project: p,
        depth: 0,
        worktrees: [],
        expanded: false,
      }));
    }
    return flattenTree(tree, expanded, worktreesByProject);
  }, [archivedView, archived, tree, expanded, worktreesByProject]);

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = toggleInSet(prev, key);
      persistExpanded(next);
      return next;
    });
  };

  // A top-level entry (a group header, or a depth-0 project) gets a gap above
  // it — except the very first row, which sits flush to the top.
  const gapFor = (i: number, r: Row) =>
    i > 0 &&
    (r.kind === "group-header" || (r.kind === "project" && r.depth === 0))
      ? GROUP_GAP
      : 0;

  // Identity-keyed rows, memoized on `rows`: the virtualizer only recomputes
  // row offsets when `count` or `getItemKey` changes — NOT when `estimateSize`
  // changes. A same-length rows change (e.g. the MRU re-sort moving a project
  // block past another) would otherwise keep stale per-index heights and
  // render overlapping rows until something altered the count.
  const rowKey = useCallback(
    (i: number) => {
      const r = rows[i];
      if (!r) return i;
      if (r.kind === "group-header") return `g:${r.node.key}`;
      if (r.kind === "worktree") return `wt:${r.worktree.id}`;
      return `p:${r.project.encoded}`;
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    getItemKey: rowKey,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r) return LEAF_HEIGHT;
      const gap = gapFor(i, r);
      if (r.kind === "group-header") return GROUP_HEIGHT + gap;
      if (r.kind === "worktree") return WORKTREE_HEIGHT;
      return LEAF_HEIGHT + gap;
    },
    overscan: 8,
  });

  const confirmCopy = useMemo(() => {
    if (!confirmTarget) return null;
    const name = lastSegment(confirmTarget.project.cwd);
    if (confirmTarget.kind === "archive") {
      return {
        title: `Archive "${name}"?`,
        body: "It will move to the Archived section. You can restore it from there at any time. Sessions continue to be tracked in the background.",
        action: "Archive",
      };
    }
    return {
      title: `Unarchive "${name}"?`,
      body: "It will return to the main project list.",
      action: "Unarchive",
    };
  }, [confirmTarget]);

  const [width, setWidth] = usePersistentNumber(
    "plan.projectSidebar.width",
    260,
  );

  return (
    <Sidebar
      className="plan-project-sidebar"
      width={width}
      onWidthChange={setWidth}
      minWidth={200}
      maxWidth={420}
    >
      <SidebarHeader className="h-[44px] justify-between pl-20 pr-3 pt-2 pb-2 [-webkit-app-region:drag]">
        <span className="font-[family-name:var(--font-mono)] text-sm font-semibold tracking-tight text-[var(--text)]">
          plan
        </span>
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenDashboard}
                aria-label="Running Claude sessions"
              >
                <GaugeIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>Running Claude sessions</span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenClaudeConfig}
                aria-label="Claude instructions & memory"
              >
                <GlobeIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>Claude instructions &amp; memory</span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenSettings}
                aria-label="Settings"
              >
                <SettingsIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span>Settings</span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={sidebar.toggle}
                aria-label="Toggle projects sidebar"
              >
                <PanelLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-1.5">
              <span>Hide projects</span>
              <Kbd keys={["⌘", "B"]} />
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {archivedView && (
          <button
            onClick={() => setArchivedView(false)}
            className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
            title="Back to projects"
          >
            <ChevronLeft />
            <span>Archived projects</span>
            <span className="text-[var(--text-tertiary)]">
              {archived.length}
            </span>
          </button>
        )}
        {projects.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            No projects yet
          </div>
        ) : (
          <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index];
                const transform = `translateY(${vi.start}px)`;

                const gap = gapFor(vi.index, row);

                if (row.kind === "group-header") {
                  // Roll up children (and their worktrees) only while collapsed;
                  // expanded, each child row shows its own dot.
                  // Roll a set over the group's children and their worktrees.
                  const groupRollup = (set: Set<string>) =>
                    !row.expanded &&
                    row.node.children.some(
                      (c) =>
                        set.has(c.encoded) ||
                        (worktreesByProject.get(c.encoded) ?? []).some((w) =>
                          set.has(w.encoded),
                        ),
                    );
                  const groupNeedsApproval = groupRollup(approvalEncoded);
                  const groupHasUnread = groupRollup(unreadEncoded);
                  const groupWorking = groupRollup(workingEncoded);
                  return (
                    <div
                      key={row.node.key}
                      className="absolute left-0 top-0 w-full"
                      style={{
                        transform,
                        height: GROUP_HEIGHT + gap,
                        paddingTop: gap,
                      }}
                    >
                      <button
                        onClick={() => toggleGroup(row.node.key)}
                        className="flex h-full w-full items-center gap-1.5 px-2.5 text-left font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
                      >
                        <ChevronRight
                          size={14}
                          className={cn(
                            "shrink-0 text-[var(--text-tertiary)] transition-transform duration-150",
                            row.expanded && "rotate-90",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {row.node.name}
                        </span>
                        <StatusDots
                          approval={groupNeedsApproval}
                          unread={groupHasUnread}
                          working={groupWorking}
                          className="mr-0.5"
                        />
                        <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                          {row.node.children.length}
                        </span>
                      </button>
                    </div>
                  );
                }

                if (row.kind === "worktree") {
                  const w = row.worktree;
                  const wp = row.project;
                  const isActive =
                    wp.encoded === selected && w.id === activeWorktreeId;
                  const wtNeedsApproval = approvalEncoded.has(w.encoded);
                  const wtHasUnread = unreadEncoded.has(w.encoded);
                  const wtWorking = workingEncoded.has(w.encoded);
                  const branch = w.repos[0]?.branch ?? "";
                  const repoCount = reposByProject.get(wp.encoded)?.length ?? 0;
                  const canAddRepos = w.repos.length < repoCount;
                  // The branch usually equals the worktree name (the name
                  // slugifies into it), so only surface it when it diverges.
                  // Same for the repo count — one line unless there's more to say.
                  const sub = [
                    branch && branch !== w.name ? branch : "",
                    w.repos.length > 1 ? `${w.repos.length} repos` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  // Vertical guide tying worktrees to their parent project —
                  // aligned to the parent's chevron centre. Consecutive worktree
                  // rows draw contiguous segments, forming one connecting line.
                  const guideX = (row.depth - 1 > 0 ? 18 : 6) + 10;
                  return (
                    <ContextMenu key={`wt:${w.id}`}>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "group absolute left-0 top-0 flex w-full items-center gap-2 pr-2 transition-colors",
                            isActive
                              ? "bg-[var(--bg-surface-hover)]"
                              : "hover:bg-[var(--bg-surface-hover)]",
                          )}
                          style={{
                            transform,
                            height: WORKTREE_HEIGHT,
                            paddingLeft: guideX + 18,
                          }}
                        >
                          <span
                            aria-hidden
                            className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--border)]"
                            style={{ left: guideX }}
                          />
                          <button
                            onClick={() => onSelectWorktree(wp.encoded, w.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <GitBranch
                              size={13}
                              className="shrink-0 text-[var(--text-tertiary)]"
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span
                                className={cn(
                                  "truncate font-[family-name:var(--font-mono)] text-[13px]",
                                  isActive
                                    ? "text-[var(--text)]"
                                    : "text-[var(--text-secondary)]",
                                )}
                              >
                                {w.name}
                              </span>
                              {sub && (
                                <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                                  {sub}
                                </span>
                              )}
                            </span>
                          </button>
                          <StatusDots
                            approval={wtNeedsApproval}
                            unread={wtHasUnread}
                            working={wtWorking}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => onCreatePr(w.id)}>
                          Create pull request…
                        </ContextMenuItem>
                        {canAddRepos && (
                          <ContextMenuItem onSelect={() => onAddRepos(w.id)}>
                            Add repos…
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem
                          destructive
                          onSelect={() => onRemoveWorktree(w.id)}
                        >
                          Remove worktree…
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                }

                const p = row.project;
                const isLiveActive =
                  p.encoded === selected && activeWorktreeId === null;
                const shortName = lastSegment(p.cwd);
                const branch = branches.get(p.encoded);
                const hasWorktrees = row.worktrees.length > 0;
                const showCount = !row.expanded && hasWorktrees;
                // The project's own live-copy session, plus (while collapsed)
                // any of its worktrees — so a collapsed project surfaces a
                // waiting worktree without needing to be expanded.
                const projRollup = (set: Set<string>) =>
                  set.has(p.encoded) ||
                  (!row.expanded &&
                    row.worktrees.some((w) => set.has(w.encoded)));
                const projNeedsApproval = projRollup(approvalEncoded);
                const projHasUnread = projRollup(unreadEncoded);
                const projWorking = projRollup(workingEncoded);
                return (
                  <ContextMenu key={p.encoded}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="absolute left-0 top-0 w-full"
                        style={{
                          transform,
                          height: LEAF_HEIGHT + gap,
                          paddingTop: gap,
                        }}
                      >
                        <div
                          className={cn(
                            "group flex h-full items-center pr-2.5 transition-colors",
                            p.archived && "opacity-60",
                            isLiveActive
                              ? "bg-[var(--bg-surface-hover)]"
                              : "hover:bg-[var(--bg-surface-hover)]",
                          )}
                          style={{
                            paddingLeft: row.depth > 0 ? 18 : 6,
                          }}
                        >
                          {hasWorktrees ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroup(p.encoded);
                              }}
                              aria-label={row.expanded ? "Collapse" : "Expand"}
                              className="flex h-full w-5 shrink-0 items-center justify-center text-[var(--text-tertiary)] transition-colors hover:text-[var(--text)]"
                            >
                              <ChevronRight
                                size={14}
                                className={cn(
                                  "transition-transform duration-150",
                                  row.expanded && "rotate-90",
                                )}
                              />
                            </button>
                          ) : (
                            <span className="w-5 shrink-0" />
                          )}
                          <button
                            onClick={() => onSelectProject(p.encoded)}
                            className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-px pr-2 text-left"
                          >
                            <ProjectIcon
                              url={iconsByProject.get(p.encoded)}
                              name={shortName}
                            />
                            <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                              <span
                                className={cn(
                                  "truncate font-[family-name:var(--font-mono)] text-[13px]",
                                  isLiveActive
                                    ? "text-[var(--text)]"
                                    : "text-[var(--text-secondary)]",
                                )}
                              >
                                {shortName}
                              </span>
                              <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                                {p.mtimeMs
                                  ? `${relativeTime(p.mtimeMs)} · `
                                  : ""}
                                {p.cwd}
                              </span>
                            </span>
                          </button>
                          <StatusDots
                            approval={projNeedsApproval}
                            unread={projHasUnread}
                            working={projWorking}
                            className="mr-1.5"
                          />
                          {/* Right slot: metadata at rest, actions on hover. The
                            actions overlay the metadata (absolute), so the row
                            never reflows and they never collide with the label. */}
                          <div className="relative flex min-w-[3.25rem] shrink-0 items-center justify-end">
                            <div
                              className={cn(
                                "flex items-center gap-1.5 transition-opacity",
                                !p.archived && "group-hover:opacity-0",
                              )}
                            >
                              {showCount && (
                                <span className="flex h-[15px] min-w-[15px] items-center justify-center rounded-full border border-[var(--border)] px-1 font-[family-name:var(--font-mono)] text-[9px] leading-none text-[var(--text-tertiary)]">
                                  {row.worktrees.length}
                                </span>
                              )}
                              {branch && (
                                <span className="max-w-[92px] truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                                  {branch}
                                </span>
                              )}
                            </div>
                            {!p.archived && (
                              <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  onClick={() =>
                                    onOpenProjectDefaults(p.encoded)
                                  }
                                  title="Project defaults"
                                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
                                >
                                  <SettingsGear size={13} />
                                </button>
                                <button
                                  onClick={() => onNewWorktree(p.encoded)}
                                  title="New worktree"
                                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)]"
                                >
                                  <Plus size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {!p.archived && (
                        <>
                          <ContextMenuItem
                            onSelect={() => onNewWorktree(p.encoded)}
                          >
                            New worktree…
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => onOpenProjectDefaults(p.encoded)}
                          >
                            Project defaults…
                          </ContextMenuItem>
                        </>
                      )}
                      {p.archived ? (
                        <ContextMenuItem
                          onSelect={() =>
                            setConfirmTarget({ kind: "unarchive", project: p })
                          }
                        >
                          Unarchive
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          destructive
                          onSelect={() =>
                            setConfirmTarget({ kind: "archive", project: p })
                          }
                        >
                          Archive…
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          </div>
        )}
      </SidebarContent>
      <SidebarFooter>
        <Button
          variant="outline"
          size="sm"
          className="h-10 w-full justify-center"
          onClick={onAddProject}
        >
          + Add project
        </Button>
        {archived.length > 0 && (
          <div className="mt-2 flex justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Archived projects"
                  onClick={() => setArchivedView((v) => !v)}
                  className={cn(
                    archivedView &&
                      "border-[var(--accent)] text-[var(--accent)]",
                  )}
                >
                  <TrashIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {archivedView ? "Back to projects" : "Archived projects"}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </SidebarFooter>

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          {confirmCopy && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmCopy.body}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    if (!confirmTarget) return;
                    await onSetArchived(
                      confirmTarget.project.encoded,
                      confirmTarget.kind === "archive",
                    );
                    setConfirmTarget(null);
                  }}
                >
                  {confirmCopy.action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
