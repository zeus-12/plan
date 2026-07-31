import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Full-screen image preview overlay. Click outside or press Escape to close;
 * ←/→ step through a set. Mirrors the composer's pasted-image preview so
 * previews feel consistent everywhere (file viewer, transcript images, …).
 *
 * Rendered through a portal into <body>: `position: fixed` is contained by any
 * ancestor with a `transform`/`filter`/`will-change`, and the workspace panes
 * use those — so without the portal the overlay clips to a pane instead of the
 * viewport.
 */
export function ImageLightbox({
  srcs,
  index = 0,
  onClose,
}: {
  srcs: string[];
  index?: number;
  onClose: () => void;
}) {
  const [at, setAt] = useState(index);
  const count = srcs.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setAt((i) => (i + 1) % count);
      else if (e.key === "ArrowLeft") setAt((i) => (i - 1 + count) % count);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, count]);

  const src = srcs[Math.min(at, count - 1)];
  if (!src) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt="preview"
          className="max-h-[90vh] max-w-[92vw] rounded-lg border border-[var(--border)] object-contain shadow-2xl"
        />
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[16px] leading-none text-[var(--text-secondary)] shadow-md transition-colors hover:bg-[var(--bg-surface-hover)]"
        >
          ×
        </button>
        {count > 1 && (
          <>
            <LightboxStep
              side="left"
              onClick={() => setAt((i) => (i - 1 + count) % count)}
            />
            <LightboxStep
              side="right"
              onClick={() => setAt((i) => (i + 1) % count)}
            />
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-white/80">
              {at + 1} / {count}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function LightboxStep({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)]/90 text-[var(--text-secondary)] shadow-md transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] ${
        side === "left" ? "-left-4" : "-right-4"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={side === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
      </svg>
    </button>
  );
}
