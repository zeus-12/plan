import { useEffect } from "react";
import { SHORTCUT_GROUPS, chordTokens, type Shortcut } from "./shortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * A read-only reference of every keyboard shortcut, rendered from the canonical
 * registry in lib/shortcuts.ts. Opened from the Settings "Keyboard shortcuts"
 * row and from ⌘/ anywhere. Same overlay shell as the Settings modal, just
 * wider — there are enough rows to want two columns.
 */
export function KeyboardShortcutsModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            Keyboard shortcuts
          </span>
          <button
            onClick={onClose}
            className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text)]"
          >
            esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="gap-x-8 sm:columns-2">
            {SHORTCUT_GROUPS.map((group) => (
              <section
                key={group.id}
                className="mb-6 break-inside-avoid last:mb-0"
              >
                <h3 className="mb-2 font-[family-name:var(--font-mono)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  {group.title}
                </h3>
                <div className="flex flex-col gap-1.5">
                  {group.shortcuts.map((s) => (
                    <ShortcutRow key={s.id} shortcut={s} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 text-[12px] text-[var(--text)]">
        {shortcut.label}
        {shortcut.when && (
          <span className="ml-1.5 text-[11px] text-[var(--text-tertiary)]">
            {shortcut.when}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {shortcut.chords.map((chord, ci) => (
          <span key={ci} className="flex items-center gap-1">
            {ci > 0 && (
              <span className="px-0.5 text-[11px] text-[var(--text-tertiary)]">
                ·
              </span>
            )}
            {chordTokens(chord).map((token, ti) => (
              <Kbd key={ti}>{token}</Kbd>
            ))}
          </span>
        ))}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[18px] items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-surface)] px-1 py-0.5 font-[family-name:var(--font-mono)] text-[10px] leading-none text-[var(--text-secondary)]">
      {children}
    </kbd>
  );
}
