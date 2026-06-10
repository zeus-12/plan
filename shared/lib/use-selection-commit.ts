import { useEffect, useRef } from "react";

/**
 * Runs `onCommit` once a text-selection gesture has settled.
 *
 * Two reasons this isn't just an `onMouseUp` on the container:
 *
 *  - **Multi-click.** A triple-click arrives as three mouseups (detail 1, 2, 3).
 *    The detail-2 (double-click) one already has a word selected — acting on it
 *    pops the comment box for just the word, before the triple-click's sentence
 *    selection lands. So when `detail >= 2` we wait out the sequence and read
 *    only the final selection.
 *  - **Release outside the container.** Dragging a multi-line selection and
 *    letting go over the margin / composer fires mouseup off the container, so a
 *    container-bound listener misses it. We listen on `document` and let the
 *    callback validate that the range is inside its own root.
 *
 * `onCommit` may change identity every render; it's read through a ref so the
 * document listener is registered once.
 */
export function useSelectionCommit(onCommit: () => void, enabled = true) {
  const cb = useRef(onCommit);
  cb.current = onCommit;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMouseUp = (e: MouseEvent) => {
      if (timer) clearTimeout(timer);
      const delay = e.detail >= 2 ? 320 : 0;
      timer = setTimeout(() => {
        timer = null;
        // rAF so the browser has finalized the selection for this frame.
        requestAnimationFrame(() => cb.current());
      }, delay);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
