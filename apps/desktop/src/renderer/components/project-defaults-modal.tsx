import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import type { ProjectDefaults, DiscoveredRepo } from "../../shared-types";

interface Props {
  encoded: string;
  defaults: ProjectDefaults;
  onSave: (defaults: ProjectDefaults) => Promise<void> | void;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

function repoLabel(r: DiscoveredRepo): string {
  return r.subPath || "repo root";
}

/**
 * Per-project defaults the user sets once: base branch + optional branch prefix
 * for new worktrees, and a per-repo Setup command (run once when a worktree is
 * created). The project's Run command lives in the Run terminal's own modal.
 */
export function ProjectDefaultsModal({ encoded, defaults, onSave, onClose }: Props) {
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [base, setBase] = useState(defaults.base ?? "");
  const [branchPrefix, setBranchPrefix] = useState(defaults.branchPrefix ?? "");
  const [setup, setSetup] = useState<Record<string, string>>(defaults.setup ?? {});
  const [autoMode, setAutoMode] = useState(defaults.autoMode ?? false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electronAPI.listRepos(encoded).then(setRepos);
    firstRef.current?.focus();
  }, [encoded]);

  const save = async () => {
    setBusy(true);
    // Drop empty command entries so the store stays clean.
    const prune = (m: Record<string, string>) =>
      Object.fromEntries(Object.entries(m).filter(([, v]) => v.trim() !== ""));
    // Spread existing defaults so the project-level run command (set in the Run
    // terminal's own modal) and any legacy fields aren't clobbered here.
    await onSave({
      ...defaults,
      base: base.trim() || undefined,
      branchPrefix: branchPrefix.trim() || undefined,
      setup: prune(setup),
      autoMode,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[520px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="mb-1 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          Project defaults
        </div>
        <div className="mb-3 text-[11px] text-[var(--text-tertiary)]">
          Pre-fills new worktrees and runs the Setup command on create.
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelCls}>Default base branch</label>
              <input
                ref={firstRef}
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
                className={inputCls}
              />
            </div>
            <div className="flex-1">
              <label className={labelCls}>Branch prefix (optional)</label>
              <input
                value={branchPrefix}
                onChange={(e) => setBranchPrefix(e.target.value)}
                placeholder="e.g. plan/"
                className={inputCls}
              />
            </div>
          </div>

          <div className="mt-1 border-t border-[var(--border)] pt-3">
            <div className={labelCls}>Setup commands</div>
            <div className="flex flex-col gap-4">
              {repos.map((r) => {
                const key = r.subPath;
                return (
                  <div key={key || "."} className="rounded-md border border-[var(--border)] p-2">
                    <div className="mb-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
                      {repoLabel(r)}
                    </div>
                    <label className={labelCls}>Setup (runs once on create)</label>
                    <input
                      value={setup[key] ?? ""}
                      onChange={(e) =>
                        setSetup((s) => ({ ...s, [key]: e.target.value }))
                      }
                      placeholder="npm install"
                      className={inputCls}
                    />
                  </div>
                );
              })}
              {repos.length === 0 && (
                <div className="text-[11px] text-[var(--text-tertiary)]">
                  No repositories discovered yet.
                </div>
              )}
            </div>
          </div>

          <div className="mt-1 border-t border-[var(--border)] pt-3">
            <div className={labelCls}>Claude session</div>
            <button
              type="button"
              onClick={() => setAutoMode((v) => !v)}
              className="flex w-full items-center justify-between gap-3 rounded-md border border-[var(--border)] p-2 text-left transition-colors hover:border-[var(--border-strong)]"
            >
              <div>
                <div className="text-[13px] text-[var(--text)]">Auto mode</div>
                <div className="text-[11px] text-[var(--text-tertiary)]">
                  Start sessions with{" "}
                  <span className="font-[family-name:var(--font-mono)]">
                    --permission-mode auto
                  </span>{" "}
                  so Claude runs without stopping for approvals.
                </div>
              </div>
              <span
                aria-checked={autoMode}
                role="switch"
                className={
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
                  (autoMode ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]")
                }
              >
                <span
                  className={
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform " +
                    (autoMode ? "translate-x-4" : "translate-x-0.5")
                  }
                />
              </span>
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
