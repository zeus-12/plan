"use client";

/* ── Merge overlay (lifted card over a change) ──────────────
 * The floating two-direction merge card the diff raises over its active
 * change. Purely presentational: position, counts, and the apply/step/close
 * handlers all come from the host. */

export interface MergeOverlayProps {
  top: number;
  height: number;
  currentIdx: number;
  totalChanges: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onApplyLeftToRight: () => void;
  onApplyRightToLeft: () => void;
}

/** Header/footer strip heights — kept narrow so the overlay barely intrudes. */
const STRIP_H = 26;

export function MergeOverlay({
  top,
  height,
  currentIdx,
  totalChanges,
  onClose,
  onPrev,
  onNext,
  onApplyLeftToRight,
  onApplyRightToLeft,
}: MergeOverlayProps) {
  // Total absolute slot: a thin strip ABOVE the change + the change rows
  // themselves (transparent middle, the diff lines beneath show through) + a
  // thin strip BELOW. Strips overlap whatever context row was immediately
  // adjacent to the change.
  return (
    <div
      data-merge-overlay
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ top: top - STRIP_H, height: height + STRIP_H * 2 }}
    >
      {/* Frame: just a ring around the whole slot, no background */}
      <div className="pointer-events-none absolute inset-x-2 inset-y-0 rounded-md shadow-[0_6px_18px_rgba(0,0,0,0.18)] ring-2 ring-[var(--accent)]" />

      {/* Header strip (above the change) */}
      <div
        className="pointer-events-auto absolute inset-x-2 top-0 flex items-center justify-between gap-2 rounded-t-md border-b border-[var(--accent)]/30 bg-[var(--bg-surface)] px-2"
        style={{ height: STRIP_H }}
      >
        <div className="flex items-center gap-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
          <span>
            Change {currentIdx + 1}{" "}
            <span className="text-[var(--text-tertiary)]">
              of {totalChanges}
            </span>
          </span>
          <button
            onClick={onPrev}
            className="ml-2 rounded px-1.5 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
            aria-label="Previous change"
            title="Previous change"
          >
            ↑
          </button>
          <button
            onClick={onNext}
            className="rounded px-1.5 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
            aria-label="Next change"
            title="Next change"
          >
            ↓
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-[16px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      {/* Footer strip (below the change). Each button sits on its own side and
          its arrow points the way the change is copied: the left button takes
          the LEFT version and applies it to the RIGHT (→); the right button
          takes the RIGHT version and applies it to the LEFT (←). */}
      <div
        className="pointer-events-auto absolute inset-x-2 bottom-0 flex items-center justify-between gap-3 rounded-b-md border-t border-[var(--accent)]/30 bg-[var(--bg-surface)] px-2"
        style={{ height: STRIP_H }}
      >
        <button
          onClick={onApplyLeftToRight}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--diff-add-bar)] px-2.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          title="Copy the left side's version to the right"
        >
          <span>Merge</span>
          <span aria-hidden>→</span>
        </button>
        <button
          onClick={onApplyRightToLeft}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--diff-remove-bar)] px-2.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          title="Copy the right side's version to the left"
        >
          <span aria-hidden>←</span>
          <span>Merge</span>
        </button>
      </div>
    </div>
  );
}
