import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Full-screen image preview overlay. Click outside or press Escape to close.
 * Mirrors the composer's pasted-image preview so previews feel consistent
 * everywhere (file viewer, transcript images, …).
 *
 * Rendered through a portal into <body>: `position: fixed` is contained by any
 * ancestor with a `transform`/`filter`/`will-change`, and the workspace panes
 * use those — so without the portal the overlay clips to a pane instead of the
 * viewport.
 */
export function ImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      </div>
    </div>,
    document.body
  );
}
