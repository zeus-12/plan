import { useId } from "react";
import { cn } from "@plan/shared/lib/utils";
import { ApprovalDot } from "./approval-dot";
import { RepliedDot, REPLIED_GREEN } from "./replied-dot";
import { WorkingIcon } from "./working-icon";

// Matches ApprovalDot's `bg-amber-500`.
const AMBER = "#f59e0b";

/**
 * Rolled-up status for a sidebar row (project / worktree / group) that may
 * aggregate several sessions. One session can be waiting on you (amber) while a
 * sibling has just replied (green) or is still working (spinner).
 *
 *   - amber and/or green → the "needs you" dot(s): a single dot, or, when both
 *     apply, a stacked pair (amber in front with a notch cut out of it so the
 *     green reads behind — amber wins, but green isn't lost).
 *   - working, with nothing waiting on you → the working spinner. It sits below
 *     the dots because it isn't actionable: if a sibling already needs you,
 *     that's what the row should show. In the common single-session flow the
 *     spinner naturally gives way to the green dot the moment the turn ends.
 */
export function StatusDots({
  approval,
  unread,
  working,
  className,
}: {
  approval: boolean;
  unread: boolean;
  working?: boolean;
  className?: string;
}) {
  if (approval && unread) return <StackedDots className={className} />;
  if (approval) return <ApprovalDot className={className} />;
  if (unread) return <RepliedDot className={className} />;
  if (working)
    return (
      <WorkingIcon
        className={cn(
          "h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]",
          className,
        )}
      />
    );
  return null;
}

/**
 * Amber + green as overlapping discs. The notch between them is a genuinely
 * transparent SVG mask cut-out (not a background-colored ring), so the stack
 * reads correctly on any row background — at rest or on hover. `useId` keys the
 * mask per instance so multiple stacks on screen don't collide.
 *
 * No pulse here (unlike a lone ApprovalDot): a pulsing halo bleeding across the
 * green would muddy the stack, and the amber's color + front position already
 * carry the "act first" precedence. The lone-approval case — by far the common
 * one — keeps its pulse.
 */
function StackedDots({ className }: { className?: string }) {
  const maskId = useId();
  return (
    <span
      className={cn("flex shrink-0 items-center", className)}
      title="One session waiting on you · another replied"
      aria-label="One session waiting on you, another replied"
    >
      <svg width="15" height="10" viewBox="0 0 15 10" fill="none">
        <mask id={maskId}>
          <rect width="15" height="10" fill="white" />
          {/* Punch a ring of clearance around the amber disc out of the green. */}
          <circle cx="10" cy="5" r="5.4" fill="black" />
        </mask>
        <circle
          cx="5"
          cy="5"
          r="4"
          fill={REPLIED_GREEN}
          mask={`url(#${maskId})`}
        />
        <circle cx="10" cy="5" r="4" fill={AMBER} />
      </svg>
    </span>
  );
}
