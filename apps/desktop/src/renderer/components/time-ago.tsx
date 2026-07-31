import { useMinuteTick } from "../lib/now";
import {
  isRelative,
  messageTime,
  relativeTime,
  toMillis,
  type TimeVariant,
} from "../lib/time";

/**
 * A relative timestamp that keeps itself current. It subscribes to the shared
 * minute clock only while its own label can still change, and re-renders just
 * this span — so a ticking transcript doesn't repaint its messages. Renders
 * nothing when the timestamp is missing or unparseable.
 */
export function TimeAgo({
  ts,
  variant = "compact",
  className,
}: {
  ts: number | string | null | undefined;
  variant?: TimeVariant;
  className?: string;
}) {
  const ms = toMillis(ts);
  useMinuteTick(isRelative(ms, variant));
  if (ms === null) return null;
  const label = variant === "message" ? messageTime(ms) : relativeTime(ms);
  if (!label) return null;
  return (
    <span className={className} title={new Date(ms).toLocaleString()}>
      {label}
    </span>
  );
}
