import { useEffect, useRef } from "react";
import { GitBranch, Plus } from "lucide-react";
import { Button } from "@plan/shared/components/ui/button";

export interface MoveTarget {
  key: string;
  label: string;
  /** Sub-line (e.g. branch), optional. */
  sub?: string;
  encoded: string;
  /** null = the project's live working copy. */
  worktreeId: string | null;
}

interface Props {
  /** Title of the chat being moved (header context). */
  sessionTitle: string;
  targets: MoveTarget[];
  onPick: (encoded: string, worktreeId: string | null) => void;
  onNewWorktree: () => void;
  onClose: () => void;
}

/**
 * Pick where a chat session moves to: an existing worktree of the project, its
 * live working copy, or a brand-new worktree. Only the conversation moves — the
 * code written so far stays on the original branch (surfaced in the footer note
 * and again as a toast after the move).
 */
export function MoveSessionModal({
  sessionTitle,
  targets,
  onPick,
  onNewWorktree,
  onClose,
}: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="mb-1 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          Move chat to worktree
        </div>
        <div className="mb-3 truncate text-[11px] text-[var(--text-tertiary)]">
          {sessionTitle}
        </div>

        <div className="flex flex-col gap-1">
          {targets.map((t, i) => (
            <button
              key={t.key}
              ref={i === 0 ? firstRef : undefined}
              onClick={() => onPick(t.encoded, t.worktreeId)}
              className="flex items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-[var(--border)] hover:bg-[var(--bg-surface-hover)]"
            >
              <GitBranch
                size={13}
                className="shrink-0 text-[var(--text-tertiary)]"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
                  {t.label}
                </span>
                {t.sub && (
                  <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    {t.sub}
                  </span>
                )}
              </span>
            </button>
          ))}
          <button
            ref={targets.length === 0 ? firstRef : undefined}
            onClick={onNewWorktree}
            className="flex items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-[var(--border)] hover:bg-[var(--bg-surface-hover)]"
          >
            <Plus size={13} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
              New worktree…
            </span>
          </button>
        </div>

        <div className="mt-3 border-t border-[var(--border)] pt-2 text-[11px] text-[var(--text-tertiary)]">
          Only the conversation moves. Any code it already wrote stays on the
          current branch — stash it manually if you need it in the worktree.
        </div>

        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
