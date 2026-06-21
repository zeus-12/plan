import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import type { ProjectDefaults, CreateWorktreeInput } from "../../shared-types";

interface Props {
  /** Per-project defaults used to pre-fill base + branch prefix. */
  defaults: ProjectDefaults;
  onCreate: (input: CreateWorktreeInput) => Promise<unknown>;
  onClose: () => void;
}

/** Branch-name-safe slug of a worktree name. */
function slugBranch(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const labelCls =
  "mb-1 block font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]";

export function NewWorktreeModal({ defaults, onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState(defaults.branchPrefix ?? "");
  const [base, setBase] = useState(defaults.base ?? "");
  // Branch auto-follows the name until the user edits it directly.
  const [branchEdited, setBranchEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const onNameChange = (v: string) => {
    setName(v);
    if (!branchEdited) {
      const prefix = defaults.branchPrefix ?? "";
      setBranch(v ? prefix + slugBranch(v) : prefix);
    }
  };

  const canSubmit =
    name.trim() !== "" && branch.trim() !== "" && base.trim() !== "" && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), branch: branch.trim(), base: base.trim() });
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
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="mb-3 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          New worktree
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. login form"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Branch</label>
            <input
              value={branch}
              onChange={(e) => {
                setBranchEdited(true);
                setBranch(e.target.value);
              }}
              placeholder="branch to create"
              className={inputCls}
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

        {error && (
          <div className="mt-3 rounded-md border border-[var(--removed-text)]/40 bg-[var(--diff-remove-bg)] px-3 py-2 text-[11px] text-[var(--removed-text)]">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            Creates a worktree in every repo · ⌘↵
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
