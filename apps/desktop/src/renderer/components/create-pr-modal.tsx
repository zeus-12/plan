import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import type {
  WorktreeRecord,
  CreatePrInput,
  CreatePrResult,
} from "../../shared-types";

interface Props {
  worktree: WorktreeRecord;
  onCreate: (input: CreatePrInput) => Promise<CreatePrResult>;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

/**
 * Create-PR approval gate for a worktree. Pre-fills title from the worktree
 * name and base from its recorded base; the user reviews and approves before
 * `gh pr create` runs. Stays open after submit to show the per-repo result
 * (real PR URLs / errors — never an optimistic "done").
 */
export function CreatePrModal({ worktree, onCreate, onClose }: Props) {
  const branch = worktree.repos[0]?.branch ?? "";
  const [title, setTitle] = useState(worktree.name);
  const [body, setBody] = useState("");
  const [base, setBase] = useState(worktree.repos[0]?.base ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatePrResult | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  const canSubmit =
    title.trim() !== "" && base.trim() !== "" && !busy && !result;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onCreate({
        title: title.trim(),
        body,
        base: base.trim(),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const multiRepo = worktree.repos.length > 1;

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
          Create pull request
        </div>
        <div className="mb-3 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {branch} → {base.trim() || "…"}
          {multiRepo ? ` · ${worktree.repos.length} repos` : ""}
        </div>

        {result ? (
          <PrResults result={result} />
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <label className={labelCls}>Title</label>
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="PR title"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Description (optional)</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe the change…"
                rows={4}
                className={`${inputCls} resize-y`}
              />
            </div>
            <div>
              <label className={labelCls}>Base branch</label>
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="e.g. main"
                className={inputCls}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-[var(--removed-text)]/40 bg-[var(--diff-remove-bg)] px-3 py-2 text-[11px] text-[var(--removed-text)]">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {result ? "" : "Pushes the branch, then opens a PR · ⌘↵"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {result ? "Done" : "Cancel"}
            </Button>
            {!result && (
              <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
                {busy ? "Creating…" : "Create PR"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-repo outcome list — real URLs and errors straight from `gh`. */
function PrResults({ result }: { result: CreatePrResult }) {
  return (
    <div className="flex flex-col gap-2">
      {result.repos.map((r) => (
        <div
          key={r.subPath || "."}
          className="rounded-md border border-[var(--border)] px-3 py-2"
        >
          <div className="mb-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
            {r.label}
          </div>
          {r.url ? (
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="break-all text-[12px] text-[var(--diff-add-bar)] underline underline-offset-2"
            >
              {r.existed ? "PR already open — " : ""}
              {r.url}
            </a>
          ) : r.skipped ? (
            <div className="text-[11px] text-[var(--text-tertiary)]">
              No changes — skipped
            </div>
          ) : (
            <div className="text-[11px] text-[var(--removed-text)]">
              {r.error || "Failed to create PR."}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
