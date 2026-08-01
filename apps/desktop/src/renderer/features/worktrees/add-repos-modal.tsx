import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import { BranchCombo } from "@/renderer/features/git/branch-combo";
import type {
  WorktreeRecord,
  AddReposToWorktreeInput,
  DiscoveredRepo,
} from "@/common/shared-types";

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
const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] font-[family-name:var(--font-mono)] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const overrideCls = (overridden: boolean) =>
  "w-36 rounded-md border bg-[var(--bg-surface)] px-2 py-1 text-[11px] font-[family-name:var(--font-mono)] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] " +
  (overridden ? "border-[var(--accent)]" : "border-[var(--border)]");

/**
 * Add repos this worktree doesn't yet span. Repos already in the worktree show
 * locked; the rest are tickable (nothing selected by default) and share one
 * base branch, overridable per repo. New checkouts reuse the worktree's branch,
 * forked from each base's remote tip.
 */
export function AddReposModal({
  worktree,
  projectEncoded,
  onAdd,
  onClose,
}: Props) {
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(null);
  const [branchesByRepo, setBranchesByRepo] = useState<
    Record<string, string[]>
  >({});
  // Nothing selected by default — the user ticks the repos to add.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repoBases, setRepoBases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A worktree spans one branch across its repos; reuse it for added repos. Its
  // first repo's base seeds the shared base for the new ones.
  const branch = worktree.repos[0]?.branch ?? "";
  const [base, setBase] = useState(worktree.repos[0]?.base ?? "");

  useEffect(() => {
    let alive = true;
    void window.electronAPI.listRepos(projectEncoded).then((r) => {
      if (alive) setRepos(r);
    });
    void window.electronAPI.listRepoBranches(projectEncoded).then((b) => {
      if (alive) setBranchesByRepo(b);
    });
    return () => {
      alive = false;
    };
  }, [projectEncoded]);

  const have = new Set(worktree.repos.map((r) => r.subPath));
  const present = (repos ?? []).filter((r) => have.has(r.subPath));
  const missing = (repos ?? []).filter((r) => !have.has(r.subPath));
  const selectedRepos = missing.filter((r) => selected.has(r.subPath));
  // Shared-field suggestions: branches across the repos still addable.
  const missingBranches = [
    ...new Set(missing.flatMap((r) => branchesByRepo[r.subPath] ?? [])),
  ].sort();

  const baseFor = (subPath: string) =>
    repoBases[subPath]?.trim() || base.trim();
  const displayedBase = (subPath: string) =>
    subPath in repoBases ? repoBases[subPath] : base;
  const isOverridden = (subPath: string) =>
    subPath in repoBases &&
    displayedBase(subPath).trim() !== "" &&
    displayedBase(subPath).trim() !== base.trim();

  const toggleRepo = (subPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(subPath)) {
        next.delete(subPath);
        setRepoBases((m) => {
          const n = { ...m };
          delete n[subPath];
          return n;
        });
      } else {
        next.add(subPath);
      }
      return next;
    });
  };
  const resetOverride = (subPath: string) =>
    setRepoBases((m) => {
      const n = { ...m };
      delete n[subPath];
      return n;
    });

  const canSubmit =
    selectedRepos.length > 0 &&
    selectedRepos.every((r) => baseFor(r.subPath) !== "") &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const bases: Record<string, string> = {};
      for (const r of selectedRepos) {
        bases[r.subPath] = baseFor(r.subPath);
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
        className="w-[460px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
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
              <label className={labelCls}>Base branch · shared</label>
              <BranchCombo
                value={base}
                onChange={setBase}
                branches={missingBranches}
                placeholder="e.g. main"
                className={inputCls}
              />
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                Applies to every repo you add unless overridden.
              </div>
            </div>

            <div>
              <label className={labelCls}>
                Add{" "}
                {selected.size === 0 && (
                  <span className="text-[var(--text-tertiary)] normal-case">
                    · none selected
                  </span>
                )}
              </label>
              <div className="flex flex-col gap-1.5">
                {missing.map((r) => {
                  const sp = r.subPath;
                  const label = sp || "repo root";
                  const on = selected.has(sp);
                  return (
                    <div
                      key={sp}
                      className={
                        // Fixed height so ticking a repo (which reveals the base
                        // field) never grows the row — only the highlight changes.
                        "flex h-10 items-center gap-2 rounded-lg border px-3 transition-colors " +
                        (on
                          ? ""
                          : "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-hover)]")
                      }
                      style={
                        on
                          ? {
                              borderColor:
                                "color-mix(in srgb, var(--accent) 42%, var(--border))",
                              backgroundColor:
                                "color-mix(in srgb, var(--accent) 9%, transparent)",
                            }
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        onClick={() => toggleRepo(sp)}
                        aria-pressed={on}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <span
                          className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition-colors"
                          style={
                            on
                              ? {
                                  background: "var(--accent)",
                                  borderColor: "var(--accent)",
                                  color: "var(--bg)",
                                }
                              : {
                                  borderColor: "var(--border-strong)",
                                  color: "transparent",
                                }
                          }
                        >
                          <Check size={11} strokeWidth={2.75} />
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px]"
                          style={{
                            color: on ? "var(--text)" : "var(--text-secondary)",
                          }}
                          title={label}
                        >
                          {label}
                        </span>
                      </button>
                      {on && (
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                            base
                          </span>
                          <BranchCombo
                            value={displayedBase(sp)}
                            onChange={(v) =>
                              setRepoBases((m) => ({ ...m, [sp]: v }))
                            }
                            branches={branchesByRepo[sp] ?? []}
                            placeholder={base || "e.g. main"}
                            className={overrideCls(isOverridden(sp))}
                            stopRowClick
                          />
                          {sp in repoBases && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                resetOverride(sp);
                              }}
                              title="Follow the shared base"
                              className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {present.length > 0 && (
              <div>
                <label className={labelCls}>Already in worktree</label>
                <div className="flex flex-col gap-1.5 opacity-60">
                  {present.map((r) => {
                    const label = r.subPath || "repo root";
                    return (
                      <div
                        key={r.subPath}
                        className="flex h-10 items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3"
                      >
                        <span
                          className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border"
                          style={{
                            background: "var(--text-tertiary)",
                            borderColor: "var(--text-tertiary)",
                            color: "var(--bg)",
                          }}
                        >
                          <Check size={11} strokeWidth={2.75} />
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-tertiary)]"
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
            {missing.length > 0 ? `Adds ${selectedRepos.length} repo(s)` : ""}
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
