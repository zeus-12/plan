import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import type { ProjectDefaults } from "../../shared-types";

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

/**
 * Per-project defaults the user sets once: the base branch new worktrees fork
 * from. The project's Run and Build commands live in the Run terminal's own
 * modal.
 */
export function ProjectDefaultsModal({
  encoded,
  defaults,
  onSave,
  onClose,
}: Props) {
  const [base, setBase] = useState(defaults.base ?? "");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  // Fields the user has edited — the fresh fetch below won't overwrite them.
  const baseTouched = useRef(false);
  // Source of truth for THIS project's defaults, read fresh by `encoded`. The
  // `defaults` prop can lag when the project was just selected; saving would
  // then spread a stale project's run/build commands into this one. Fetching by
  // encoded avoids clobbering the target project's other fields.
  const [liveDefaults, setLiveDefaults] = useState<ProjectDefaults>(defaults);

  useEffect(() => {
    firstRef.current?.focus();
  }, [encoded]);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.getWorktreeDefaults(encoded).then((d) => {
      if (!alive) return;
      setLiveDefaults(d);
      if (!baseTouched.current) setBase(d.base ?? "");
    });
    return () => {
      alive = false;
    };
  }, [encoded]);

  const save = async () => {
    setBusy(true);
    // Spread existing defaults so the project-level run/build commands (set in
    // the Run terminal's own modal) and any legacy fields aren't clobbered here.
    await onSave({ ...liveDefaults, base: base.trim() || undefined });
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
          Pre-fills new worktrees.
        </div>

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
