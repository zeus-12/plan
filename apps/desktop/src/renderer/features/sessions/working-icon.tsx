import { cn } from "@plan/shared/lib/utils";

// A 3×3 grid. Centers are pushed near the viewBox edges and the dots sized up so
// the cluster fills the box (little dead padding) and stays legible at ~14px.
const COORDS = [10, 28, 46] as const;
const N = COORDS.length;

/**
 * Animated "compile" indicator shown next to a session/tab while its agent is
 * working — a grid whose columns fill bottom-up then release together.
 *
 * Both dot layers use `currentColor`, so the icon inherits the surrounding text
 * color and stays correct in every theme. The per-cell stagger is computed
 * inline (bottom row first, columns staggered left→right) so the stylesheet
 * stays one rule; the keyframes live in globals.css under `.compile-icon`.
 *
 * Callers size it via `className` (e.g. `h-3.5 w-3.5`). Slot it into a
 * fixed-size container so toggling it on/off never shifts neighbouring text.
 */
export function WorkingIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 56 56"
      role="img"
      aria-label="Working"
      className={cn("compile-icon", className)}
    >
      {COORDS.map((y, row) =>
        COORDS.map((x, col) => (
          <circle key={`b${row}${col}`} className="bg" cx={x} cy={y} r={4} />
        )),
      )}
      {COORDS.map((y, row) =>
        COORDS.map((x, col) => (
          <circle
            key={`l${row}${col}`}
            className="lit"
            cx={x}
            cy={y}
            r={5}
            style={{ animationDelay: `${(N - 1 - row) * 300 + col * 120}ms` }}
          />
        )),
      )}
    </svg>
  );
}
