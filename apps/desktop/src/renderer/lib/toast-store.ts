import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function pushToast(t: Omit<Toast, "id">, ttlMs = 12_000) {
  const toast: Toast = { ...t, id: nextId++ };
  toasts = [...toasts, toast];
  emit();
  setTimeout(() => dismissToast(toast.id), ttlMs);
}

export function dismissToast(id: number) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => toasts,
    () => toasts
  );
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
