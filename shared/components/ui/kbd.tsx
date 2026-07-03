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
        // No fixed color — pills inherit `currentColor` from their context
        // (tertiary text, an outline button, or the accent send button) so they
        // always read against whatever they sit on, including dark mode.
        "inline-flex items-center gap-0.5 font-[family-name:var(--font-mono)] text-[10px]",
        className,
      )}
      {...rest}
    >
      {keys.map((k, i) => (
        <span
          key={i}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-current/25 bg-current/10 px-1 text-[10px] leading-none opacity-90"
        >
          {k}
        </span>
      ))}
    </kbd>
  );
}
