import type { ReactNode } from "react";
import { cn } from "@plan/shared/lib/utils";

/** The panel's own ground (see Sidebar) — the footer sits on it, and the fade
 *  above resolves to it, so neither one draws an edge of its own. */
const PANEL = "var(--bg-chrome, var(--bg-surface))";

/**
 * A sidebar's one action. The footer itself is plain: the panel's ground, the
 * button, nothing else. The only treated area is the 16px directly ABOVE it,
 * where the list's last rows dissolve — the same relationship the transcript has
 * with the composer (message-list.tsx). Nothing is laid over the button, and the
 * top padding keeps a strip of untouched ground between the fade and the button
 * so a half-faded row can't read as the button's own content.
 */
export function ListFooter({
  label,
  onClick,
  trailing,
}: {
  label: string;
  onClick: () => void;
  /** Optional secondary control, e.g. the archived-items toggle. */
  trailing?: ReactNode;
}) {
  return (
    <div
      className="relative flex shrink-0 items-center gap-1.5 px-2.5 pb-2.5"
      style={{ background: PANEL }}
    >
      {/* 1px of blur, not a frosting: the job is to soften where the rows are
          cut off, not to push them behind glass. */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-4 h-4 backdrop-blur-[1px]"
        style={{
          background: `linear-gradient(to top, ${PANEL}, transparent)`,
          maskImage: "linear-gradient(to top, black, transparent)",
          WebkitMaskImage: "linear-gradient(to top, black, transparent)",
        }}
      />
      <button
        onClick={onClick}
        className="list-footer-action flex h-8 flex-1 items-center justify-center rounded-lg font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
      >
        {label}
      </button>
      {/* No slot when there's no control, so the action spans the panel. Both
          callers reveal one only once something is archived, so the label does
          shift a little the first time that happens. */}
      {trailing && <div className="h-8 w-8 shrink-0">{trailing}</div>}
    </div>
  );
}

/** The trailing slot's control — sized and cornered to match the action. */
export function ListFooterIcon({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]",
        active ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </button>
  );
}
