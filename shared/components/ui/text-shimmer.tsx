import { cn } from "../../lib/utils";

export type TextShimmerProps = {
  as?: React.ElementType;
  /** Seconds for one sweep. */
  duration?: number;
  /** Half-width of the lit band, in % of the gradient. Clamped to 5–45. */
  spread?: number;
} & React.HTMLAttributes<HTMLElement>;

/**
 * Text whose highlight sweeps left→right, for labels that mean "still running".
 *
 * Colors come from `--shimmer-base` / `--shimmer-lit`, defaulting to the theme's
 * tertiary and primary text — set those two vars on the element (or an ancestor)
 * to retune it per context instead of passing colors.
 */
/**
 * Palette for a shimmer sitting on a filled accent button, where the text is
 * `--bg` on `--accent` — the sweep runs between a half-mixed `--bg` and a solid
 * one, since the theme's text tokens would be invisible against that fill.
 */
export const onAccentShimmer = {
  "--shimmer-base": "color-mix(in srgb, var(--bg) 40%, var(--accent))",
  "--shimmer-lit": "var(--bg)",
} as React.CSSProperties;

export function TextShimmer({
  as: Component = "span",
  className,
  duration = 4,
  spread = 20,
  children,
  style,
  ...props
}: TextShimmerProps) {
  const dynamicSpread = Math.min(Math.max(spread, 5), 45);
  const base = "var(--shimmer-base, var(--text-tertiary))";
  const lit = "var(--shimmer-lit, var(--text))";

  return (
    <Component
      className={cn(
        "text-shimmer bg-size-[200%_auto] bg-clip-text text-transparent",
        "animate-[shimmer_4s_infinite_linear]",
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(to right, ${base} ${50 - dynamicSpread}%, ${lit} 50%, ${base} ${50 + dynamicSpread}%)`,
        animationDuration: `${duration}s`,
        ...style,
      }}
      {...props}
    >
      {children}
    </Component>
  );
}
