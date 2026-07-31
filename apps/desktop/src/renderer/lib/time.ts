const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * `compact` is the sidebar/list wording, `message` the one under a transcript
 * message — they differ past a day ("yesterday", a shorter date), so each keeps
 * its own tail.
 */
export type TimeVariant = "compact" | "message";

/** Past this age a variant only ever renders a fixed date, so it stops changing. */
const RELATIVE_WINDOW: Record<TimeVariant, number> = {
  compact: 31 * DAY,
  message: 15 * DAY,
};

export function toMillis(
  input: number | string | null | undefined,
): number | null {
  if (input == null) return null;
  const ms = typeof input === "string" ? Date.parse(input) : input;
  return Number.isFinite(ms) ? ms : null;
}

/** Whether this timestamp's label still changes as the clock moves. */
export function isRelative(
  input: number | string | null | undefined,
  variant: TimeVariant,
  nowMs: number = Date.now(),
): boolean {
  const ms = toMillis(input);
  return ms !== null && nowMs - ms < RELATIVE_WINDOW[variant];
}

function withinADay(diff: number): string | null {
  if (diff < MINUTE) return "just now";

  const mins = Math.floor(diff / MINUTE);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diff / HOUR);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  return null;
}

/**
 * Human-friendly recency: "just now", "2 mins ago", "2 hours ago", "3 days
 * ago", "2 weeks ago" — and beyond a month, the actual date as dd/mm/yyyy.
 */
export function relativeTime(
  input: number | string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const ms = toMillis(input);
  if (ms === null) return "";
  const diff = nowMs - ms;
  const recent = withinADay(diff);
  if (recent) return recent;

  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  const weeks = Math.floor(days / 7);
  if (days < 31) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;

  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/**
 * Timestamp shown under a message. Stays relative while the message is recent
 * — "just now", "5 mins ago", "3 hours ago", "yesterday", "10 days ago" — so
 * anything within the last two weeks reads at a glance. Past 14 days it flips
 * to an absolute Indian-format date, DD/MM/YY. The stored timestamp is UTC ISO;
 * Date does the local-timezone conversion. Empty on an unparseable ts.
 */
export function messageTime(
  input: number | string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const ms = toMillis(input);
  if (ms === null) return "";
  const diff = nowMs - ms;
  const recent = withinADay(diff);
  if (recent) return recent;

  const days = Math.floor(diff / DAY);
  if (days === 1) return "yesterday";
  if (days <= 14) return `${days} days ago`;

  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
