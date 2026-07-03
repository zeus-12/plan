import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import type {
  ProjectDefaults,
  CreateWorktreeInput,
  DiscoveredRepo,
} from "../../shared-types";

interface Props {
  /** Per-project defaults used to pre-fill the base branch. */
  defaults: ProjectDefaults;
  /** Project whose repos the worktree will span (for per-repo base selection). */
  projectEncoded: string;
  onCreate: (input: CreateWorktreeInput) => Promise<unknown>;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

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
  // override falls back to the global `base` when blank, so editing the global
  // base flows to every repo that hasn't been overridden. `excluded` holds the
  // repos the user unticked — repos default to included, so absence = included.
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(null);
  const [repoBases, setRepoBases] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    branchRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.listRepos(projectEncoded).then((r) => {
      if (alive) setRepos(r);
    });
    return () => {
      alive = false;
    };
  }, [projectEncoded]);

  const multiRepo = (repos?.length ?? 0) > 1;
  const selected = (repos ?? []).filter((r) => !excluded[r.subPath]);
  // A repo's base is its override, falling back to the global default.
  const baseFor = (subPath: string) =>
    repoBases[subPath]?.trim() || base.trim();

  const canSubmit =
    branch.trim() !== "" &&
    // Single-repo uses the one global base; multi-repo needs every spanned repo
    // to resolve a base (its own input, since the global field is hidden).
    (multiRepo
      ? selected.length > 0 && selected.every((r) => baseFor(r.subPath) !== "")
      : base.trim() !== "") &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Send an effective base for each included repo (override or global default).
      const bases: Record<string, string> = {};
      for (const r of selected) {
        bases[r.subPath] = baseFor(r.subPath);
      }
      // The backend still wants a top-level base as the fallback default; with the
      // global field hidden for multi-repo, borrow the first spanned repo's base.
      const fallbackBase = multiRepo
        ? base.trim() || baseFor(selected[0].subPath)
        : base.trim();
      await onCreate({
        name: branch.trim(),
        branch: branch.trim(),
        base: fallbackBase,
        repos: multiRepo ? selected.map((r) => r.subPath) : undefined,
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
        className="w-[420px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
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
          {!multiRepo && (
            <div>
              <label className={labelCls}>Base branch</label>
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="e.g. main"
                className={inputCls}
              />
            </div>
          )}

          {multiRepo && (
            <div>
              <label className={labelCls}>Repos &amp; base</label>
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
                {repos!.map((r) => {
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
                        title={on ? "Included" : "Excluded"}
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
                        value={repoBases[sp] ?? base}
                        onChange={(e) =>
                          setRepoBases((m) => ({ ...m, [sp]: e.target.value }))
                        }
                        disabled={!on}
                        placeholder={base || "e.g. main"}
                        className="w-40 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 text-[12px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)] disabled:opacity-40"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                Each repo forks from its remote (origin) tip. Unticked repos are
                skipped — add them later from the worktree.
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
              ? `Spans ${selected.length} of ${repos!.length} repos`
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
                "Creating…"
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
