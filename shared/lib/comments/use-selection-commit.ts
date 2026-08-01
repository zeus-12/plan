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
export function useSelectionCommit(
  onCommit: (clickCount: number) => void,
  enabled = true,
) {
  const cb = useRef(onCommit);
  cb.current = onCommit;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMouseUp = (e: MouseEvent) => {
      if (timer) clearTimeout(timer);
      // Wait out the rest of a multi-click. Each click in the sequence clears
      // the previous timer, so the commit only runs once no further click
      // lands within this window. Kept above the OS multi-click interval
      // (~500ms on macOS) so a triple-click's third click reliably cancels the
      // double-click's pending commit — otherwise the box pops for the word
      // first, then re-opens for the sentence, causing a layout shift.
      const clickCount = e.detail;
      const delay = clickCount >= 2 ? 500 : 0;
      timer = setTimeout(() => {
        timer = null;
        // rAF so the browser has finalized the selection for this frame.
        requestAnimationFrame(() => cb.current(clickCount));
      }, delay);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
