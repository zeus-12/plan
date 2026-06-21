import { toast } from "sonner";

export interface Toast {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * In-app toast. Rendered by Sonner's <Toaster> (stacking, exit animations and
 * timing are all handled there); this is just the thin call-site adapter.
 */
export function pushToast(t: Toast, ttlMs = 12_000) {
  toast(t.text, {
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
  opts: { silent?: boolean } = {},
) {
  try {
    new Notification(title, { body, silent: opts.silent ?? false });
  } catch {
    // Notifications unavailable — the in-app toast still covers it.
  }
}
