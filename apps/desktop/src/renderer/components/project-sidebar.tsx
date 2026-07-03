import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@plan/shared/lib/utils";
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
import type { ProjectEntry } from "../../shared-types";
import { relativeTime } from "../lib/time";
import {
  buildProjectTree,
  flattenTree,
  type VisibleItem,
} from "../lib/project-tree";

interface Props {
  projects: ProjectEntry[];
  reposByProject: Map<string, import("../../shared-types").DiscoveredRepo[]>;
  selected: string | null;
  onSelect: (encoded: string) => void;
  onAddProject: () => void;
  onSetArchived: (encoded: string, archived: boolean) => Promise<void> | void;
  onOpenDashboard: () => void;
  onOpenSettings: () => void;
  /** Open the global ~/.claude/CLAUDE.md (and the rest of the config tree). */
  onOpenClaudeConfig: () => void;
}

const LEAF_HEIGHT = 50;
const GROUP_HEIGHT = 36;
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

function ChevronLeftIcon() {
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
      <polyline points="15 18 9 12 15 6" />
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

export function ProjectSidebar({
  projects,
  reposByProject,
  selected,
  onSelect,
  onAddProject,
  onSetArchived,
  onOpenDashboard,
  onOpenSettings,
  onOpenClaudeConfig,
}: Props) {
  const sidebar = useSidebar();
  // Pick a representative branch per project: first repo's branch.
  // (Multi-repo projects don't worktree-group, so this is the right label.)
  const branches = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const [enc, repos] of reposByProject) {
      map.set(enc, repos[0]?.branch ?? null);
    }
    return map;
  }, [reposByProject]);
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

  // Auto-expand the group containing the selected project so it's visible.
  useEffect(() => {
    if (!selected) return;
    for (const n of tree) {
      if (n.kind !== "group") continue;
      if (
        n.children.some((c) => c.encoded === selected) &&
        !expanded.has(n.key)
      ) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(n.key);
          persistExpanded(next);
          return next;
        });
        return;
      }
    }
  }, [selected, tree, expanded]);

  // Leave the archived view automatically once it's empty (e.g. last unarchive).
  useEffect(() => {
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length]);

  const rows: Row[] = useMemo(() => {
    if (archivedView) {
      return archived.map((p) => ({ kind: "leaf", project: p, depth: 0 }));
    }
    return flattenTree(tree, expanded);
  }, [archivedView, archived, tree, expanded]);

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistExpanded(next);
      return next;
    });
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r) return LEAF_HEIGHT;
      if (r.kind === "group-header") return GROUP_HEIGHT;
      return LEAF_HEIGHT;
    },
    overscan: 8,
  });

  const confirmCopy = useMemo(() => {
    if (!confirmTarget) return null;
    const name =
      confirmTarget.project.cwd.split("/").filter(Boolean).pop() ??
      confirmTarget.project.cwd;
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
            <ChevronLeftIcon />
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

                if (row.kind === "group-header") {
                  return (
                    <button
                      key={row.node.key}
                      onClick={() => toggleGroup(row.node.key)}
                      className="absolute left-0 top-0 flex w-full items-center gap-2 px-3 text-left font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
                      style={{ transform, height: GROUP_HEIGHT }}
                    >
                      <span
                        className={cn(
                          "inline-block text-[9px] text-[var(--text-tertiary)] transition-transform",
                          row.expanded && "rotate-90",
                        )}
                      >
                        ▶
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {row.node.name}
                      </span>
                      <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                        {row.node.children.length}
                      </span>
                    </button>
                  );
                }

                const p = row.project;
                const isSelected = p.encoded === selected;
                const shortName =
                  p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
                return (
                  <ContextMenu key={p.encoded}>
                    <ContextMenuTrigger asChild>
                      <button
                        onClick={() => onSelect(p.encoded)}
                        title={p.cwd}
                        className={cn(
                          "absolute left-0 top-0 flex w-full flex-col justify-center gap-0.5 border-l-2 pr-3 text-left transition-colors",
                          p.archived && "opacity-60",
                          isSelected
                            ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]"
                            : "border-l-transparent hover:bg-[var(--bg-surface-hover)]",
                        )}
                        style={{
                          transform,
                          height: LEAF_HEIGHT,
                          paddingLeft: row.depth > 0 ? 28 : 12,
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-xs",
                              isSelected
                                ? "text-[var(--text)]"
                                : "text-[var(--text-secondary)]",
                            )}
                          >
                            {shortName}
                          </span>
                          {branches.get(p.encoded) && (
                            <span className="shrink-0 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] max-w-[80px]">
                              {branches.get(p.encoded)}
                            </span>
                          )}
                        </div>
                        <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                          {p.mtimeMs ? `${relativeTime(p.mtimeMs)} · ` : ""}
                          {p.cwd}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
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
