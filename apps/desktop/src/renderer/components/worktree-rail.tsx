import { Plus, Settings } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import type { WorktreeRecord } from "../../shared-types";

interface Props {
  projectName: string;
  /** Branch the live working copy is currently on (for the top row label). */
  liveBranch: string | null;
  worktrees: WorktreeRecord[];
  /** null selects the live working-copy row. */
  activeWorktreeId: string | null;
  onSelectLive: () => void;
  onSelectWorktree: (id: string) => void;
  onNew: () => void;
  onRemove: (id: string) => void;
  onAddRepos: (id: string) => void;
  onCreatePr: (id: string) => void;
  onOpenSettings: () => void;
  /** Repos discovered in the project; the "+" shows when a worktree spans fewer. */
  projectRepoCount: number;
  /**
   * True when the projects sidebar is collapsed, so this rail is flush against
   * the window's left edge and the macOS traffic lights would overlap the
   * header. Reserves a draggable strip above it.
   */
  trafficLightInset?: boolean;
}

// Flat, full-width rows with a left-border accent — the same shape the project
// and session sidebars use, so all three columns read consistently.
const rowCls =
  "group flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors";
const activeCls = "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]";
const idleCls = "border-l-transparent hover:bg-[var(--bg-surface-hover)]";

/**
 * Left sidebar: the live working-copy row + this project's worktrees. The
 * project switcher (dropdown) lives above this; here we own everything scoped
 * to one project.
 */
export function WorktreeRail({
  projectName,
  liveBranch,
  worktrees,
  activeWorktreeId,
  onSelectLive,
  onSelectWorktree,
  onNew,
  onRemove,
  onAddRepos,
  onCreatePr,
  onOpenSettings,
  projectRepoCount,
  trafficLightInset = false,
}: Props) {
  const liveActive = activeWorktreeId === null;
  return (
    <div className="flex h-full flex-col font-[family-name:var(--font-mono)] text-[13px]">
      {/* Clear the macOS traffic lights when this rail is flush-left; the strip
          stays draggable so the window can be moved from it. */}
      {trafficLightInset && (
        <div className="h-7 shrink-0 [-webkit-app-region:drag]" />
      )}
      {/* Header — mirrors the other sidebars' uppercase mono section labels. */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          Worktrees
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenSettings}
            title="Project defaults"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            <Settings size={13} />
          </button>
          <button
            onClick={onNew}
            title="New worktree"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
        {/* Live working copy — the real checkout you opened, whatever branch
            it's on. The small green pip marks it as the live tree, as opposed
            to the worktree clones listed below. */}
        <button
          onClick={onSelectLive}
          className={cn(rowCls, liveActive ? activeCls : idleCls)}
        >
          <span className="flex h-2 w-2 shrink-0 items-center justify-center">
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--diff-add-bar)]"
              title="Live working copy"
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "truncate",
                liveActive
                  ? "text-[var(--text)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              {projectName}
            </span>
            <span className="truncate text-[11px] text-[var(--text-tertiary)]">
              {liveBranch ? `${liveBranch} · working copy` : "working copy"}
            </span>
          </span>
        </button>

        {worktrees.map((w) => {
          const active = w.id === activeWorktreeId;
          const branch = w.repos[0]?.branch ?? "";
          return (
            <div
              key={w.id}
              className={cn(rowCls, active ? activeCls : idleCls)}
            >
              <button
                onClick={() => onSelectWorktree(w.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {/* Empty slot keeps worktree labels aligned with the live row. */}
                <span className="h-2 w-2 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "truncate",
                      active
                        ? "text-[var(--text)]"
                        : "text-[var(--text-secondary)]",
                    )}
                  >
                    {w.name}
                  </span>
                  <span className="truncate text-[11px] text-[var(--text-tertiary)]">
                    {branch}
                    {w.repos.length > 1 ? ` · ${w.repos.length} repos` : ""}
                  </span>
                </span>
              </button>
              {w.repos.length < projectRepoCount && (
                <button
                  onClick={() => onAddRepos(w.id)}
                  title="Add repos to this worktree"
                  className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)] group-hover:flex"
                >
                  <Plus size={13} />
                </button>
              )}
              <button
                onClick={() => onCreatePr(w.id)}
                title="Create pull request"
                className="hidden h-6 shrink-0 items-center justify-center rounded px-1.5 text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)] group-hover:flex"
              >
                PR
              </button>
              <button
                onClick={() => onRemove(w.id)}
                title="Remove worktree"
                className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-[13px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--removed-text)] group-hover:flex"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
