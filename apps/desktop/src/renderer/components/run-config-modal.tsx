import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";

interface Props {
  runCommand?: string;
  buildCommand?: string;
  /** Persisted to the project (shared across worktrees + sessions). */
  onSave: (runCommand: string, buildCommand: string) => Promise<void> | void;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

/**
 * Configure the project's Run terminal command. The command is project-level
 * (one per project, retained across worktrees + sessions); only the running
 * process is per-worktree. Run is gated on a non-empty run command.
 */
export function RunConfigModal({
  runCommand,
  buildCommand,
  onSave,
  onClose,
}: Props) {
  const [run, setRun] = useState(runCommand ?? "");
  const [build, setBuild] = useState(buildCommand ?? "");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const canSave = run.trim() !== "" && !busy;

  const save = async () => {
    if (run.trim() === "") return;
    setBusy(true);
    await onSave(run.trim(), build.trim());
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[460px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
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
          Run command
        </div>
        <div className="mb-3 text-[11px] text-[var(--text-tertiary)]">
          Shared across every worktree and session of this project.
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Run command</label>
            <input
              ref={firstRef}
              value={run}
              onChange={(e) => setRun(e.target.value)}
              placeholder="npm run dev"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Build command (optional)</label>
            <input
              value={build}
              onChange={(e) => setBuild(e.target.value)}
              placeholder="npm install"
              className={inputCls}
            />
            <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
              Runs before the run command, in the same terminal.
            </div>
          </div>
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
