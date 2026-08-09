import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dissolve a horizontal scroller's overflowing ends instead of guillotining
 * their content mid-glyph. Returns the scroller ref, the scroll handler, and a
 * `mask-image` that's undefined while nothing overflows (so the common case
 * paints no mask at all).
 *
 * Apply the mask to the scroller itself — anything that must stay solid (a
 * pinned button, a divider) belongs on an unmasked wrapper around it.
 */
export function useEdgeFade(
  /** Changes when the scroller's children do — re-measures and re-observes them.
   *  Adding an item grows scrollWidth without resizing the scroller, so nothing
   *  else would tell us the ends now overflow. */
  watch: unknown,
  fadePx = "28px",
): {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  mask: string | undefined;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  // Bails when nothing changed, so a scroll re-renders only at the two
  // transitions rather than every frame.
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px slack: fractional widths leave sub-pixel remainders at the ends.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    setFade((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  // Resizing the pane, or adding/removing an item, changes what overflows
  // without ever firing a scroll event.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [sync, watch]);

  const mask =
    fade.start || fade.end
      ? `linear-gradient(to right, transparent, #000 ${fade.start ? fadePx : "0px"}, #000 calc(100% - ${fade.end ? fadePx : "0px"}), transparent)`
      : undefined;

  return { ref, onScroll: sync, mask };
}
