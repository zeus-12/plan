import { useEffect, useRef, type ReactNode } from "react";
import { Command } from "cmdk";
import { cn } from "@plan/shared/lib/utils";

export interface PaletteItem {
  /** Unique id (also cmdk's value). */
  id: string;
  label: string;
  sublabel?: string;
  /** Optional leading icon (e.g. a file-type icon). */
  icon?: ReactNode;
  /** Optional right-aligned tag (e.g. "project", "chat"). */
  badge?: string;
  onSelect: () => void;
}

interface Props {
  open: boolean;
  placeholder: string;
  query: string;
  onQueryChange: (q: string) => void;
  /** Already filtered + ordered by the caller (we disable cmdk's own filter). */
  items: PaletteItem[];
  onClose: () => void;
  emptyLabel?: string;
}

/**
 * Generic ⌘K/⌘P palette. cmdk gives the input + arrow/enter navigation; the
 * caller does the fuzzy filtering (so it can cap results and stay fast on huge
 * file lists), so cmdk's own filter is turned off.
 */
export function CommandPalette({
  open,
  placeholder,
  query,
  onQueryChange,
  items,
  onClose,
  emptyLabel = "No results",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Focus after mount so typing starts immediately.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Command
          shouldFilter={false}
          loop
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        >
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={onQueryChange}
            placeholder={placeholder}
            className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <Command.List className="max-h-[50vh] overflow-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
              {emptyLabel}
            </Command.Empty>
            {items.map((it) => (
              <Command.Item
                key={it.id}
                value={it.id}
                onSelect={it.onSelect}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 rounded-md px-3 py-2 font-[family-name:var(--font-mono)]",
                  "data-[selected=true]:bg-[var(--bg-surface-hover)]"
                )}
              >
                {it.icon && (
                  <span className="shrink-0 self-center">{it.icon}</span>
                )}
                <span className="shrink-0 truncate text-[13px] text-[var(--text)]">
                  {it.label}
                </span>
                {it.sublabel && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">
                    {it.sublabel}
                  </span>
                )}
                {it.badge && (
                  <span className="ml-auto shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
                    {it.badge}
                  </span>
                )}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
