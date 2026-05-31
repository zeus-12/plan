export function relativeTime(input: number | string | null | undefined): string {
  if (input == null) return "";
  const ms = typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}
