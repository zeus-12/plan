import { dismissToast, useToasts } from "../lib/toast-store";

/** Bottom-right toast stack. */
export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[320px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-[12px] leading-snug text-[var(--text)]">
              {t.text}
            </span>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-[14px] leading-none text-[var(--text-tertiary)] hover:text-[var(--text)]"
            >
              ×
            </button>
          </div>
          {t.actionLabel && (
            <button
              onClick={() => {
                t.onAction?.();
                dismissToast(t.id);
              }}
              className="mt-2 rounded-md bg-[var(--accent)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
