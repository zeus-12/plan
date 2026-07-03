"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SettingsRow {
  label: string;
  control: ReactNode;
}

/**
 * A gear button that toggles a small popover of labelled controls — the same
 * shape the diff surface uses, factored out so other surfaces (the doc page)
 * get an identical settings affordance. Purely presentational: callers own the
 * setting state and pass the control widgets.
 */
export function SettingsPopover({
  rows,
  title = "Settings",
}: {
  rows: SettingsRow[];
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-md border text-[14px] transition-colors ${
          open
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
        }`}
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 flex w-max flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5 shadow-lg">
          {rows.map(({ label, control }) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <span className="text-[11px] text-[var(--text-tertiary)]">
                {label}
              </span>
              {control}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
