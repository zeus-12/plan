import { cn } from "@plan/shared/lib/utils";

/** Disclosure chevron: points right, rotates down when `open`. */
export function Chevron({
  open,
  size = 10,
  strokeWidth = 2.5,
  className,
}: {
  open: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "shrink-0 transition-transform",
        open && "rotate-90",
        className,
      )}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/** Back-navigation chevron (points left). */
export function ChevronLeft({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
