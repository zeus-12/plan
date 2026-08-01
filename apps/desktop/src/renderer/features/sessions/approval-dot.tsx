import { cn } from "@plan/shared/lib/utils";

/**
 * "This session is waiting on you" indicator — a small amber dot with a soft
 * pulsing halo. Amber (not the app accent) because it's an alert that needs to
 * read as distinct from selection/working states at a glance; the halo draws
 * the eye without the whole row changing color.
 *
 * Used wherever a target can be waiting on an approval/plan/question menu: the
 * session list, and rolled up onto sidebar project / worktree / group rows.
 */
export function ApprovalDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("relative flex h-2 w-2 shrink-0", className)}
      title="Waiting on your input"
      aria-label="Waiting on your input"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400/70" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
    </span>
  );
}
