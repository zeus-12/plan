/**
 * Human-friendly recency: "just now", "2 mins ago", "2 hours ago", "3 days
 * ago", "2 weeks ago" — and beyond a month, the actual date as dd/mm/yyyy.
 */
export function relativeTime(
  input: number | string | null | undefined,
): string {
  if (input == null) return "";
  const ms = typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";

  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  const weeks = Math.floor(days / 7);
  if (days < 31) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;

  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}
