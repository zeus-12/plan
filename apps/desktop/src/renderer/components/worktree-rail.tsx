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
  onCreatePr: (id: string) => void;
  onOpenSettings: () => void;
}

const rowCls =
  "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors";

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
  onCreatePr,
  onOpenSettings,
}: Props) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-2 font-[family-name:var(--font-mono)] text-[12px]">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          Worktrees
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onOpenSettings}
            title="Project defaults"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            ⚙
          </button>
          <button
            onClick={onNew}
            title="New worktree"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            ＋
          </button>
        </div>
      </div>

      {/* Live working copy — the real checkout, whatever branch it's on. */}
      <button
        onClick={onSelectLive}
        className={cn(
          rowCls,
          activeWorktreeId === null
            ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
        )}
      >
        <span className="text-[var(--diff-add-bar)]">●</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[var(--text)]">{projectName}</span>
          <span className="truncate text-[10px] text-[var(--text-tertiary)]">
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
            className={cn(
              rowCls,
              active
                ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
            )}
          >
            <button
              onClick={() => onSelectWorktree(w.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="text-[var(--text-tertiary)]">▸</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[var(--text)]">{w.name}</span>
                <span className="truncate text-[10px] text-[var(--text-tertiary)]">
                  {branch}
                  {w.repos.length > 1 ? ` · ${w.repos.length} repos` : ""}
                </span>
              </span>
            </button>
            <button
              onClick={() => onCreatePr(w.id)}
              title="Create pull request"
              className="hidden h-5 shrink-0 items-center justify-center rounded px-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text)] group-hover:flex"
            >
              PR
            </button>
            <button
              onClick={() => onRemove(w.id)}
              title="Remove worktree"
              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--removed-text)] group-hover:flex"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
