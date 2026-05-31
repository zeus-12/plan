import { cn } from "../../lib/utils";

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Keys to render, e.g. ["⌘", "B"]. */
  keys: string[];
}

/**
 * Native macOS-style keycap pills. Use sparingly, e.g. next to actions.
 */
export function Kbd({ keys, className, ...rest }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]",
        className
      )}
      {...rest}
    >
      {keys.map((k, i) => (
        <span
          key={i}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg)] px-1 text-[10px] leading-none"
        >
          {k}
        </span>
      ))}
    </kbd>
  );
}
