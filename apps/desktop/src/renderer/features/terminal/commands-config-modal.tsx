import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import type { CommandEntry, DiscoveredRepo } from "@/common/shared-types";
import { newEntryId } from "./commands";

interface Props {
  /** "Run" or "Build" — titles the modal and the empty-row placeholder. */
  title: string;
  /** One-line note under the title. */
  description: string;
  entries: CommandEntry[];
  /** Sub-repos of the project — populate the per-row target dropdown (multi-repo only). */
  repos: DiscoveredRepo[];
  /** Persist the full list (empty commands dropped). Shared across worktrees + sessions. */
  onSave: (entries: CommandEntry[]) => Promise<void> | void;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const selectCls =
  "shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]";

function repoName(subPath: string): string {
  return subPath.split("/").pop() || subPath;
}

/**
 * Configure a project's Run/Build command list. Each row is a command, optionally
 * bound to a git sub-repo (its cwd) when the project spans several repos. The "+"
 * adds a row; hitting Run/Build later starts them all together. The list is
 * project-level (shared across worktrees + sessions); only the running processes
 * are per-worktree.
 */
export function CommandsConfigModal({
  title,
  description,
  entries,
  repos,
  onSave,
  onClose,
}: Props) {
  const multiRepo = repos.length > 1;
  const [rows, setRows] = useState<CommandEntry[]>(() =>
    entries.length > 0
      ? entries.map((e) => ({ ...e }))
      : [{ id: newEntryId(), command: "" }],
  );
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const setRow = (id: string, patch: Partial<CommandEntry>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((prev) => [...prev, { id: newEntryId(), command: "" }]);
  const removeRow = (id: string) =>
    setRows((prev) => prev.filter((r) => r.id !== id));

  const cleaned = rows
    .filter((r) => r.command.trim() !== "")
    .map((r) => ({
      id: r.id,
      command: r.command.trim(),
      ...(r.subPath ? { subPath: r.subPath } : {}),
    }));
  const canSave = cleaned.length > 0 && !busy;

  const save = async () => {
    if (cleaned.length === 0) return;
    setBusy(true);
    await onSave(cleaned);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[520px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div className="mb-1 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          {title} commands
        </div>
        <div className="mb-3 text-[11px] text-[var(--text-tertiary)]">
          {description}
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={row.id} className="flex items-center gap-2">
              {multiRepo && (
                <select
                  value={row.subPath ?? ""}
                  onChange={(e) =>
                    setRow(row.id, { subPath: e.target.value || undefined })
                  }
                  className={selectCls}
                  title="Run this command in…"
                >
                  <option value="">root</option>
                  {repos
                    .filter((r) => r.subPath)
                    .map((r) => (
                      <option key={r.subPath} value={r.subPath}>
                        {repoName(r.subPath)}
                      </option>
                    ))}
                </select>
              )}
              <input
                ref={i === 0 ? firstRef : undefined}
                value={row.command}
                onChange={(e) => setRow(row.id, { command: e.target.value })}
                placeholder={
                  title === "Build" ? "npm run build" : "npm run dev"
                }
                className={inputCls}
              />
              <button
                onClick={() => removeRow(row.id)}
                disabled={rows.length === 1}
                title="Remove command"
                aria-label="Remove command"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[16px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30"
              >
                ×
              </button>
            </div>
          ))}

          <button
            onClick={addRow}
            className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          >
            <span className="text-[14px] leading-none">+</span>
            Add command
          </button>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
