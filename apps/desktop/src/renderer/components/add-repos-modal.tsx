import { useEffect, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import type {
  WorktreeRecord,
  AddReposToWorktreeInput,
  DiscoveredRepo,
} from "../../shared-types";

interface Props {
  /** The worktree to extend. */
  worktree: WorktreeRecord;
  /** The parent project, whose repos we diff against the worktree's. */
  projectEncoded: string;
  onAdd: (input: AddReposToWorktreeInput) => Promise<unknown>;
  onClose: () => void;
}

const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";
const baseInputCls =
  "w-40 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 text-[12px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] disabled:opacity-40";

/**
 * Add repos this worktree doesn't yet span. Repos already in the worktree show
 * locked; the rest are tickable (default on) with a per-repo base. New checkouts
 * reuse the worktree's branch, forked from each base's remote tip.
 */
export function AddReposModal({
  worktree,
  projectEncoded,
  onAdd,
  onClose,
}: Props) {
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(null);
  // Repos the user unticked — missing repos default to included, so absence here
  // means included.
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [repoBases, setRepoBases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A worktree spans one branch across its repos; reuse it for added repos. Its
  // first repo's base is the sensible default for the new ones.
  const branch = worktree.repos[0]?.branch ?? "";
  const defaultBase = worktree.repos[0]?.base ?? "";

  useEffect(() => {
    let alive = true;
    void window.electronAPI.listRepos(projectEncoded).then((r) => {
      if (alive) setRepos(r);
    });
    return () => {
      alive = false;
    };
  }, [projectEncoded]);

  const have = new Set(worktree.repos.map((r) => r.subPath));
  const present = (repos ?? []).filter((r) => have.has(r.subPath));
  const missing = (repos ?? []).filter((r) => !have.has(r.subPath));
  const selected = missing.filter((r) => !excluded[r.subPath]);

  const canSubmit =
    selected.length > 0 &&
    selected.every(
      (r) => (repoBases[r.subPath] ?? defaultBase).trim() !== "",
    ) &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const bases: Record<string, string> = {};
      for (const r of selected) {
        bases[r.subPath] = (repoBases[r.subPath] ?? defaultBase).trim();
      }
      await onAdd({ bases });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[440px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="mb-1 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          Add repos to “{worktree.name}”
        </div>
        <div className="mb-3 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          New repos check out on branch {branch || "—"}, forked from each remote
          (origin) base.
        </div>

        {repos === null ? (
          <div className="py-4 text-center text-[11px] text-[var(--text-tertiary)]">
            Loading repos…
          </div>
        ) : missing.length === 0 ? (
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-[12px] text-[var(--text-secondary)]">
            This worktree already spans every repo in the project.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className={labelCls}>Add</label>
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
                {missing.map((r) => {
                  const sp = r.subPath;
                  const label = sp || "repo root";
                  const on = !excluded[sp];
                  return (
                    <div key={sp} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          setExcluded((m) => ({
                            ...m,
                            [sp]: !e.target.checked,
                          }))
                        }
                        className="shrink-0 accent-[var(--accent)]"
                      />
                      <span
                        className={
                          "min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[11px] " +
                          (on
                            ? "text-[var(--text-secondary)]"
                            : "text-[var(--text-tertiary)] line-through")
                        }
                        title={label}
                      >
                        {label}
                      </span>
                      <input
                        value={repoBases[sp] ?? defaultBase}
                        onChange={(e) =>
                          setRepoBases((m) => ({ ...m, [sp]: e.target.value }))
                        }
                        disabled={!on}
                        placeholder={defaultBase || "e.g. main"}
                        className={baseInputCls}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {present.length > 0 && (
              <div>
                <label className={labelCls}>Already in worktree</label>
                <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 opacity-60">
                  {present.map((r) => {
                    const label = r.subPath || "repo root";
                    return (
                      <div key={r.subPath} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked
                          disabled
                          className="shrink-0 accent-[var(--accent)]"
                        />
                        <span
                          className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
                          title={label}
                        >
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--removed-text)]/40 bg-[var(--diff-remove-bg)] px-3 py-2 text-[11px] text-[var(--removed-text)]">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {missing.length > 0 ? `Adds ${selected.length} repo(s)` : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {missing.length === 0 ? "Close" : "Cancel"}
            </Button>
            {missing.length > 0 && (
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={!canSubmit}
              >
                {busy ? (
                  "Adding…"
                ) : (
                  <>
                    Add repos
                    <Kbd keys={["⌘", "↵"]} />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
