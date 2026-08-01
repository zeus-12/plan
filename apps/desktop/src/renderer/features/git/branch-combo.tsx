import { useMemo, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Remote branch names to suggest. Free text is always allowed. */
  branches: string[];
  placeholder?: string;
  /** Classes for the <input> — callers pass the field styling. */
  className?: string;
  /** Stops the row's click-to-toggle from firing when used inside a row. */
  stopRowClick?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
}

const MAX = 8;

/**
 * A branch-name text input with lightweight autocomplete. The field is always
 * freely typeable — the dropdown only *suggests* real remote branches (matched
 * as a substring) and never constrains what you can enter. Suggestions come
 * from the repo's remote-tracking refs; a branch that isn't listed can still be
 * typed and is fetched on create.
 */
export function BranchCombo({
  value,
  onChange,
  branches,
  placeholder,
  className,
  stopRowClick,
  autoFocus,
  "aria-label": ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    return branches
      .filter((b) => {
        const lb = b.toLowerCase();
        return lb !== q && (q === "" || lb.includes(q));
      })
      .slice(0, MAX);
  }, [branches, value]);

  const showList = open && matches.length > 0;

  const pick = (b: string) => {
    onChange(b);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onClick={stopRowClick ? (e) => e.stopPropagation() : undefined}
    >
      <input
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        className={className}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // Let the modal's ⌘/Ctrl+↵ submit bubble untouched.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return;
          if (!showList) {
            // Escape closes nothing here — let it bubble so the modal closes.
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            e.stopPropagation();
            pick(matches[active]);
          } else if (e.key === "Escape") {
            // Swallow so the modal stays open — Escape just closes the list.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul className="absolute left-0 top-full z-50 mt-1 max-h-44 w-full min-w-[8rem] overflow-auto rounded-md border border-[var(--border-strong)] bg-[var(--popover-bg)] p-1 shadow-lg">
          {matches.map((b, i) => (
            <li key={b}>
              <button
                type="button"
                // preventDefault keeps focus on the input so onBlur doesn't fire
                // before the click registers.
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  pick(b);
                }}
                onMouseEnter={() => setActive(i)}
                className={
                  "block w-full truncate rounded px-2 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)] " +
                  (i === active ? "bg-[var(--bg-surface-hover)]" : "")
                }
              >
                {b}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
