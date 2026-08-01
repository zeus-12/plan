import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import {
  TextShimmer,
  onAccentShimmer,
} from "@plan/shared/components/ui/text-shimmer";
import { BranchCombo } from "@/renderer/features/git/branch-combo";
import type {
  ProjectDefaults,
  CreateWorktreeInput,
  DiscoveredRepo,
} from "@/common/shared-types";

interface Props {
  /** Per-project defaults used to pre-fill the base branch. */
  defaults: ProjectDefaults;
  /** Project whose repos the worktree will span (for per-repo base selection). */
  projectEncoded: string;
  onCreate: (input: CreateWorktreeInput) => Promise<unknown>;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] font-[family-name:var(--font-mono)] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

// Small per-repo override field; accent border once it diverges from the shared base.
const overrideCls = (overridden: boolean) =>
  "w-36 rounded-md border bg-[var(--bg-surface)] px-2 py-1 text-[11px] font-[family-name:var(--font-mono)] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] " +
  (overridden ? "border-[var(--accent)]" : "border-[var(--border)]");

export function NewWorktreeModal({
  defaults,
  projectEncoded,
  onCreate,
  onClose,
}: Props) {
  // One field is both the branch to create and the worktree's name.
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(defaults.base ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Repos the worktree spans, and per-repo base overrides keyed by subPath. An
  // override falls back to the shared `base` when blank, so editing the shared
  // base flows to every repo that hasn't been touched. `selected` holds the
  // repos the user ticked — nothing is selected by default.
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(null);
  const [branchesByRepo, setBranchesByRepo] = useState<
    Record<string, string[]>
  >({});
  const [repoBases, setRepoBases] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const branchRef = useRef<HTMLInputElement>(null);
  // Once the user edits the base, stop letting the fetched default overwrite it.
  const baseTouched = useRef(false);

  useEffect(() => {
    branchRef.current?.focus();
  }, []);

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

  // Pre-fill the base from THIS project's defaults. The `defaults` prop can lag
  // when the target project was just selected (its worktree store hasn't
  // refetched yet), so read fresh by projectEncoded — the source of truth for
  // the project the worktree is actually being created in.
  useEffect(() => {
    let alive = true;
    void window.electronAPI.getWorktreeDefaults(projectEncoded).then((d) => {
      if (alive && !baseTouched.current) setBase(d.base ?? "");
    });
    return () => {
      alive = false;
    };
  }, [projectEncoded]);

  const multiRepo = (repos?.length ?? 0) > 1;
  const selectedRepos = (repos ?? []).filter((r) => selected.has(r.subPath));
  // Suggestions for the shared field: every branch across the project's repos.
  const allBranches = [...new Set(Object.values(branchesByRepo).flat())].sort();
  // A repo's base is its override, falling back to the shared default.
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
    branch.trim() !== "" &&
    (multiRepo
      ? selectedRepos.length > 0 &&
        selectedRepos.every((r) => baseFor(r.subPath) !== "")
      : base.trim() !== "") &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Send an effective base for each included repo (override or shared default).
      const bases: Record<string, string> = {};
      for (const r of selectedRepos) {
        bases[r.subPath] = baseFor(r.subPath);
      }
      // The backend still wants a top-level base as the fallback default.
      const fallbackBase = multiRepo
        ? base.trim() || baseFor(selectedRepos[0].subPath)
        : base.trim();
      await onCreate({
        name: branch.trim(),
        branch: branch.trim(),
        base: fallbackBase,
        repos: multiRepo ? selectedRepos.map((r) => r.subPath) : undefined,
        bases: multiRepo ? bases : undefined,
      });
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
          // Keys the modal owns must not leak to listeners outside it (e.g.
          // the global ⌘↵ a focused composer/textarea handles). stopPropagation
          // alone leaves React's portal-bubbling and any native window/document
          // listeners reachable, so also stop the native event immediately.
          const stop = () => {
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          };
          if (e.key === "Escape") {
            stop();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            stop();
            void submit();
          }
        }}
      >
        <div className="mb-3 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          New worktree
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Branch</label>
            <input
              ref={branchRef}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="branch to create"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>
              Base branch{multiRepo ? " · shared" : ""}
            </label>
            <BranchCombo
              value={base}
              onChange={(v) => {
                baseTouched.current = true;
                setBase(v);
              }}
              branches={allBranches}
              placeholder="e.g. main"
              className={inputCls}
            />
            {multiRepo && (
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                Applies to every selected repo unless overridden.
              </div>
            )}
          </div>

          {multiRepo && (
            <div>
              <label className={labelCls}>
                Repos{" "}
                {selected.size === 0 && (
                  <span className="text-[var(--text-tertiary)] normal-case">
                    · none selected
                  </span>
                )}
              </label>
              <div className="flex flex-col gap-1.5">
                {repos!.map((r) => {
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
              <div className="mt-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                Each repo forks from its remote (origin) tip. Skipped repos can
                be added later from the worktree.
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--removed-text)]/40 bg-[var(--diff-remove-bg)] px-3 py-2 text-[11px] text-[var(--removed-text)]">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {multiRepo
              ? `Spans ${selectedRepos.length} of ${repos!.length} repos`
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? (
                <TextShimmer duration={2.4} style={onAccentShimmer}>
                  Creating…
                </TextShimmer>
              ) : (
                <>
                  Create
                  <Kbd keys={["⌘", "↵"]} />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
