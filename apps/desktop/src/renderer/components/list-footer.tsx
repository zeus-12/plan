import type { ReactNode } from "react";
import { cn } from "@plan/shared/lib/utils";

/** Bottom padding a scroll area needs so its last row clears {@link ListFooter}. */
export const LIST_FOOTER_PAD = 64;

const RAMP = "linear-gradient(to top, #000 calc(100% - 18px), transparent)";

/**
 * A sidebar's one action, floating over the bottom of its list rather than
 * sitting in a ruled band below it. The tint and the blur both ramp out across
 * the bar's top 18px, so rows dissolve as they pass under instead of meeting an
 * edge — same idea as the transcript's fade under the composer, except masking
 * the bar itself keeps the blur and the tint ramping together.
 *
 * The bar doesn't take pointer events; only its controls do. Without that, the
 * ramp — invisible but still hit-testable — would swallow clicks on the row
 * beneath it. Give the scroll area {@link LIST_FOOTER_PAD} of bottom padding.
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
      className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2.5 pt-6 pb-3 backdrop-blur-md"
      style={{
        background:
          "linear-gradient(to top, color-mix(in srgb, var(--bg) 84%, transparent), color-mix(in srgb, var(--bg) 62%, transparent))",
        maskImage: RAMP,
        WebkitMaskImage: RAMP,
      }}
    >
      <button
        onClick={onClick}
        className="pointer-events-auto flex h-7 flex-1 items-center justify-center rounded-lg bg-[var(--bg-surface)] font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
      >
        {label}
      </button>
      {trailing}
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
        "pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text)]",
        active ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </button>
  );
}
