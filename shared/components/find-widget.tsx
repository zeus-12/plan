"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/utils";
import type { TextFind } from "../lib/use-text-find";

/**
 * VS Code-style find widget, pinned to the top-right of a content pane. Purely
 * presentational over a {@link TextFind} state object — the surface decides how
 * matches are painted and scrolled. Renders nothing when `find.open` is false.
 *
 * `revealTrigger` bumps (e.g. each ⌘F press) to re-focus + select the input.
 */
export function FindWidget({
  find,
  revealTrigger,
}: {
  find: TextFind;
  revealTrigger: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!find.open) return;
    const el = inputRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [find.open, revealTrigger]);

  if (!find.open) return null;

  const total = find.matches.length;
  const count = total === 0 ? (find.query ? "No results" : "") : `${find.current + 1} of ${total}`;

  return (
    <div
      className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-1 shadow-xl"
      // Keep clicks/selection inside the widget from bubbling to the pane.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 focus-within:border-[var(--border-strong)]">
        <input
          ref={inputRef}
          value={find.query}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.shiftKey ? find.prev() : find.next();
            } else if (e.key === "Escape") {
              e.preventDefault();
              find.close();
            }
          }}
          placeholder="Find"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-6 w-44 bg-transparent font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]"
        />
        <Toggle on={find.options.caseSensitive} onClick={() => find.toggle("caseSensitive")} title="Match Case">
          Aa
        </Toggle>
        <Toggle on={find.options.wholeWord} onClick={() => find.toggle("wholeWord")} title="Match Whole Word">
          <span className="underline">ab</span>
        </Toggle>
        <Toggle on={find.options.regex} onClick={() => find.toggle("regex")} title="Use Regular Expression">
          .*
        </Toggle>
      </div>

      <span className="min-w-[64px] px-1 text-center font-[family-name:var(--font-mono)] text-[10px] tabular-nums text-[var(--text-tertiary)]">
        {count}
      </span>

      <IconBtn onClick={find.prev} disabled={total === 0} title="Previous match (⇧↵)">
        <ChevronUp />
      </IconBtn>
      <IconBtn onClick={find.next} disabled={total === 0} title="Next match (↵)">
        <ChevronDown />
      </IconBtn>
      <IconBtn onClick={find.close} title="Close (Esc)">
        <CloseX />
      </IconBtn>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] leading-none transition-colors",
        on
          ? "bg-[var(--accent)] text-[var(--bg)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

function IconBtn({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ChevronUp() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function CloseX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
