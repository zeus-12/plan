import { toast } from "sonner";

export interface Toast {
  /** Generic category line, rendered as the bold heading. */
  title: string;
  /** The specific data/detail shown under the title. Optional — omit for
   *  one-liners (e.g. debug toasts) that have nothing extra to say. */
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Stable key — a repeat push with the same id refreshes the existing toast
   *  in place instead of stacking a new one (e.g. per-session "done"). */
  id?: string;
}

/**
 * In-app toast. Rendered by Sonner's <Toaster> (stacking, exit animations and
 * timing are all handled there); this is just the thin call-site adapter.
 */
export function pushToast(t: Toast, ttlMs = 12_000) {
  toast(t.title, {
    id: t.id,
    description: t.description,
    duration: ttlMs,
    action: t.actionLabel
      ? { label: t.actionLabel, onClick: () => t.onAction?.() }
      : undefined,
  });
}

/**
 * OS-level notification. By default it carries the system sound; pass
 * `{ silent: true }` when a caller plays its own sound (e.g. the session-done
 * notifier's configurable chime) so the two don't double up.
 */
export function osNotify(
  title: string,
  body: string,
  opts: { silent?: boolean; tag?: string } = {},
) {
  try {
    // `tag` collapses repeats: a new banner with the same tag replaces the
    // previous one rather than stacking another (e.g. per-session "done").
    new Notification(title, {
      body,
      silent: opts.silent ?? false,
      tag: opts.tag,
    });
  } catch {
    // Notifications unavailable — the in-app toast still covers it.
  }
}
