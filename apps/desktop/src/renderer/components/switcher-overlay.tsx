import { useEffect, useRef } from "react";
import { cn } from "@plan/shared/lib/utils";

export interface SwitcherItem {
  key: string;
  label: string;
  sub?: string;
  /** Render a labeled separator above this row (groups the list visually). */
  divider?: boolean;
  /** Caption shown in the separator, e.g. "Recent chats". */
  dividerLabel?: string;
}

interface Props {
  title: string;
  items: SwitcherItem[];
  /** Highlighted index. */
  index: number;
}

/**
 * Centered Ctrl+Tab switcher modal. Purely presentational — the cycling and
 * commit lifecycle live in useTabSwitcher; this just shows the list and which
 * row is highlighted, keeping it scrolled into view.
 */
export function SwitcherOverlay({ title, items, index }: Props) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30">
      <div className="flex max-h-[70vh] w-[min(420px,80vw)] flex-col overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-2xl">
        <div className="shrink-0 border-b border-[var(--border)] px-4 py-2.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {title}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.map((item, i) => {
            const active = i === index;
            return (
              <div key={item.key}>
                {item.divider && (
                  <div className="my-1.5 flex items-center gap-2 px-1.5">
                    {item.dividerLabel && (
                      <span className="shrink-0 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
                        {item.dividerLabel}
                      </span>
                    )}
                    <div className="h-px flex-1 bg-[var(--border-strong)]" />
                  </div>
                )}
                <div
                  ref={active ? activeRef : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors",
                    active ? "bg-[var(--accent)]" : "bg-transparent"
                  )}
                >
                  <div className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "truncate font-[family-name:var(--font-mono)] text-[12px]",
                        active ? "text-[var(--bg)]" : "text-[var(--text)]"
                      )}
                    >
                      {item.label}
                    </span>
                    {item.sub && (
                      <span
                        className={cn(
                          "truncate font-[family-name:var(--font-mono)] text-[10px]",
                          active
                            ? "text-[var(--bg)] opacity-70"
                            : "text-[var(--text-tertiary)]"
                        )}
                      >
                        {item.sub}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
