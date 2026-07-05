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
 * Per-project defaults the user sets once: base branch for new worktrees, and a
 * per-repo Setup command (run once when a worktree is created). The project's Run
 * command lives in the Run terminal's own modal.
 */
export function ProjectDefaultsModal({
  encoded,
  defaults,
  onSave,
  onClose,
}: Props) {
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [base, setBase] = useState(defaults.base ?? "");
  const [setup, setSetup] = useState<Record<string, string>>(
    defaults.setup ?? {},
  );
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  // Fields the user has edited — the fresh fetch below won't overwrite them.
  const baseTouched = useRef(false);
  const setupTouched = useRef(false);
  // Source of truth for THIS project's defaults, read fresh by `encoded`. The
  // `defaults` prop can lag when the project was just selected; saving would
  // then spread a stale project's run/build commands into this one. Fetching by
  // encoded avoids clobbering the target project's other fields.
  const [liveDefaults, setLiveDefaults] = useState<ProjectDefaults>(defaults);

  useEffect(() => {
    window.electronAPI.listRepos(encoded).then(setRepos);
    firstRef.current?.focus();
  }, [encoded]);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.getWorktreeDefaults(encoded).then((d) => {
      if (!alive) return;
      setLiveDefaults(d);
      if (!baseTouched.current) setBase(d.base ?? "");
      if (!setupTouched.current) setSetup(d.setup ?? {});
    });
    return () => {
      alive = false;
    };
  }, [encoded]);

  const save = async () => {
    setBusy(true);
    // Drop empty command entries so the store stays clean.
    const prune = (m: Record<string, string>) =>
      Object.fromEntries(Object.entries(m).filter(([, v]) => v.trim() !== ""));
    // Spread existing defaults so the project-level run command (set in the Run
    // terminal's own modal) and any legacy fields aren't clobbered here.
    await onSave({
      ...liveDefaults,
      base: base.trim() || undefined,
      setup: prune(setup),
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
          <div>
            <label className={labelCls}>Default base branch</label>
            <input
              ref={firstRef}
              value={base}
              onChange={(e) => {
                baseTouched.current = true;
                setBase(e.target.value);
              }}
              placeholder="main"
              className={inputCls}
            />
          </div>

          <div className="mt-1 border-t border-[var(--border)] pt-3">
            <div className={labelCls}>Setup commands</div>
            <div className="flex flex-col gap-4">
              {repos.map((r) => {
                const key = r.subPath;
                return (
                  <div
                    key={key || "."}
                    className="rounded-md border border-[var(--border)] p-2"
                  >
                    <div className="mb-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
                      {repoLabel(r)}
                    </div>
                    <label className={labelCls}>
                      Setup (runs once on create)
                    </label>
                    <input
                      value={setup[key] ?? ""}
                      onChange={(e) => {
                        setupTouched.current = true;
                        setSetup((s) => ({ ...s, [key]: e.target.value }));
                      }}
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
