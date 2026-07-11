import { cn } from "@plan/shared/lib/utils";

// Muted green — a step desaturated from the theme's added-text green so it reads
// as a calm "there's a reply here" without competing with the amber approval
// dot's brighter, pulsing "act now". Hardcoded (like the amber dot) because a
// status color should read consistently across themes, not track the accent.
export const REPLIED_GREEN = "#78b681";

/**
 * "Claude replied — you haven't looked yet" indicator. A small, STATIC green dot
 * (no pulse): nothing is blocked or burning, it's just waiting for your eyes.
 * The stillness is the whole point — it's what separates it from the amber
 * approval dot's live pulse. Clears when you view the session (see
 * unread-response-store).
 */
export function RepliedDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("flex h-2 w-2 shrink-0", className)}
      title="Claude replied — needs you"
      aria-label="Claude replied — needs you"
    >
      <span
        className="inline-flex h-2 w-2 rounded-full"
        style={{ backgroundColor: REPLIED_GREEN }}
      />
    </span>
  );
}
