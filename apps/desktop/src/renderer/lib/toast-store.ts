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
 * OS-level notification (with the system sound) — used when the window isn't
 * focused so activity isn't missed. In-app states use toasts instead.
 */
export function osNotify(title: string, body: string) {
  try {
    new Notification(title, { body, silent: false });
  } catch {
    // Notifications unavailable — the in-app toast still covers it.
  }
}
