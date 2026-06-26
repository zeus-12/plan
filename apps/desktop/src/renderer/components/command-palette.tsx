import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Command } from "cmdk";
import { cn } from "@plan/shared/lib/utils";

export interface PaletteItem {
  /** Unique id (also cmdk's value). */
  id: string;
  label: string;
  sublabel?: string;
  /**
   * Optional muted "origin" line under the label (e.g. a renamed chat's old
   * name). Rendered dimmed with a `↳` glyph so it reads as "derived from".
   */
  hint?: string;
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
 * One result row, memoised on the item. Because we control cmdk's selection,
 * every hover/arrow/keystroke re-renders the palette — without this each of
 * those would re-render all ~200 rows. The caller memoises `items`, so an
 * item's reference is stable when only the selection moves: memo bails and only
 * the two rows whose selected-state actually changed (handled inside cmdk's own
 * per-item subscription) re-render.
 */
const PaletteRow = memo(function PaletteRow({ item }: { item: PaletteItem }) {
  return (
    <Command.Item
      value={item.id}
      onSelect={item.onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 font-[family-name:var(--font-mono)]",
        "data-[selected=true]:bg-[var(--bg-surface-hover)]",
      )}
    >
      {item.icon && <span className="shrink-0">{item.icon}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 truncate text-[13px] text-[var(--text)]">
            {item.label}
          </span>
          {item.sublabel && (
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">
              {item.sublabel}
            </span>
          )}
        </div>
        {item.hint && (
          <span className="flex items-center gap-1 truncate text-[11px] italic leading-tight text-[var(--text-tertiary)]">
            <span className="not-italic opacity-60">↳</span>
            <span className="truncate">{item.hint}</span>
          </span>
        )}
      </div>
      {item.badge && (
        <span className="ml-auto shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {item.badge}
        </span>
      )}
    </Command.Item>
  );
});

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
  const listRef = useRef<HTMLDivElement>(null);

  // cmdk's selection is controlled, and crucially DERIVED during render rather
  // than set in an effect. Left uncontrolled, cmdk preserves the selected row as
  // the results reorder under typing and scrolls the list to wherever that row
  // moved — the "jumps to where that item is" bug. Pinning the value to the
  // first row fixes it, but only if it happens synchronously: if we set it in an
  // effect, cmdk renders once still pointing at the stale row and scrolls there
  // before the effect corrects it. So we tag each manual selection (arrow keys)
  // with the query it was made under; the instant the query changes, `value`
  // falls back to the first row in the very same render — no stale frame.
  const [picked, setPicked] = useState<{ query: string; id: string } | null>(
    null,
  );
  const value = picked?.query === query ? picked.id : (items[0]?.id ?? "");

  useEffect(() => {
    if (open) {
      // Focus after mount so typing starts immediately.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // A changed result set means a new search: pin the scroll to the top. Runs
  // before paint, so the list never visibly scrolls — results just appear from
  // the top. Selection is already pinned to the first row (above), so cmdk has
  // no stale row to scroll to afterwards. Keyed on `items` (memoised by the
  // caller, stable across arrow-key navigation) so it fires only on real result
  // changes, not when you move the selection.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [items]);

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
          value={value}
          onValueChange={(id) =>
            // Bail if the selection is unchanged: cmdk re-asserts the current
            // value after each keystroke, and a no-op state update here would
            // re-render the palette for nothing.
            setPicked((prev) =>
              prev?.id === id && prev.query === query ? prev : { query, id },
            )
          }
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
          {/*
            overflow-anchor:none — rows are keyed by path, so typing reuses the
            surviving rows and inserts newer matches above them. Without this the
            browser's scroll anchoring bumps scrollTop down to keep a reused row
            stationary, making the list drift downward on its own. cmdk already
            re-selects the first row each keystroke, so disabling anchoring keeps
            the view pinned at the top where the best matches appear.
          */}
          <Command.List
            ref={listRef}
            className="max-h-[50vh] overflow-auto p-1.5 [overflow-anchor:none]"
          >
            <Command.Empty className="px-3 py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
              {emptyLabel}
            </Command.Empty>
            {items.map((it) => (
              <PaletteRow key={it.id} item={it} />
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
