import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";

interface Props {
  /** Current display name, prefilled and selected. */
  initialName: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

/**
 * Minimal rename modal: overlay + input. Enter saves, Esc / click-outside
 * closes. Saving an empty name clears the custom name (derived title returns).
 */
export function RenameSessionDialog({ initialName, onSave, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    onSave(name);
    onClose();
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
          Rename chat
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Chat name"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
