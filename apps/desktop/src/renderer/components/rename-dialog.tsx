import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";

interface Props {
  /** Heading, e.g. "Rename chat". */
  title: string;
  placeholder: string;
  /** Current display name, prefilled and selected. */
  initialName: string;
  /** Rejecting keeps the dialog open and surfaces the reason. */
  onSave: (name: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Minimal rename modal: overlay + input. Enter saves, Esc / click-outside
 * closes. Saving an empty name clears the custom name (derived title returns).
 */
export function RenameDialog({
  title,
  placeholder,
  initialName,
  onSave,
  onClose,
}: Props) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name);
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
        className="w-[380px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          {title}
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
        />
        {error && (
          <div className="mt-3 whitespace-pre-wrap break-words rounded-md border border-[var(--removed-text)]/40 bg-[var(--diff-remove-bg)] px-3 py-2 text-[11px] text-[var(--removed-text)]">
            {error}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
