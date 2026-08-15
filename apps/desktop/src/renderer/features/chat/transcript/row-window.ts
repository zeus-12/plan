import { useCallback, useEffect, useRef, useState } from "react";

/** Rows within this many viewports of the visible box render their content. */
const RENDER_MARGIN = 1.5;
/** A row keeps its content until it is this far out, so a small oscillating
 *  scroll can't thrash the rows at the edge of the window. */
const KEEP_MARGIN = 3;
/** Height reserved for a row nobody has measured yet. */
const SEED_ROW_HEIGHT = 152;
/** Within this of the end counts as following the newest message. */
const BOTTOM_EPSILON = 40;
/** Gap left above a row jumped to, matching the row's own scroll margin. */
const JUMP_MARGIN = 12;
/** How many frames a jump keeps re-pinning while heights settle. */
const JUMP_SETTLE_FRAMES = 12;

export interface RowWindow {
  /** True when this row should render its content. */
  shows: (i: number) => boolean;
  /** Style for a row that doesn't: holds its place and nothing else. */
  reserve: (i: number) => { height: string };
  /** Re-pick the window against the current layout, before the next paint. */
  sync: () => void;
  /** Same, coalesced into the next frame. */
  schedule: () => void;
  /** Put this message at the top of the viewport and keep it there while the
   *  rows around it render and settle. */
  scrollToRow: (uuid: string) => void;
}

/**
 * Renders only the rows near the viewport.
 *
 * Opening a chat used to build every row's content synchronously inside the
 * click handler: traced at 318ms of React for 887 rows, so ~640ms at 1,790.
 * `useDeferredValue` does not help, because it defers updates and this is a
 * mount. Style and layout were never the problem — they measured under 90ms.
 *
 * A row outside the window renders no children and holds its place with the
 * height it was last measured at, so the document keeps its shape and the
 * scroll position stays meaningful.
 *
 * The window is found by binary search over real `offsetTop`. An estimated
 * coordinate system drifts from the real layout and then points the window at
 * the wrong rows, which shows up as a blank transcript.
 *
 * `forceRange` renders an extra slice on demand. The find indexer walks the
 * chat in chunks that way, reading each row's real text once and caching it, so
 * searching never needs the whole transcript mounted.
 */
export function useRowWindow(
  scrollRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
  items: readonly object[],
  /** Rows to render on top of the window, for the find indexer to read their
   *  real text. Harvested in chunks so no single frame renders the whole chat. */
  forceRange: { start: number; end: number } | null,
  /** Hold the window still. The find indexer renders slices all over the chat,
   *  and recomputing the window from that churn feeds back into itself. */
  frozen = false,
): RowWindow {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Keyed on the message object: merge-session substitutes a new object when a
  // message changes and keeps the old one when it doesn't, so identity is an
  // exact cache key and a stale height can't survive an edit.
  const measured = useRef(new WeakMap<object, number>());
  // Once a row has been given a reserved height it keeps it until it is really
  // measured. The running estimate moves as rows are measured, and letting it
  // flow back into rows already on the page would resize every unvisited row at
  // once — at 1,750 rows a 5px shift moves the document 8,750px, with nothing to
  // compensate it. A reservation is a commitment.
  const reserved = useRef(new WeakMap<object, number>());
  const estimate = useRef(SEED_ROW_HEIGHT);
  const layoutKey = useRef("");
  const anchor = useRef<{
    index: number;
    offset: number;
    at: number;
    atBottom: boolean;
  } | null>(null);
  const jump = useRef<{ uuid: string; frames: number } | null>(null);
  const rafRef = useRef(0);
  const inPass = useRef(false);
  const [range, setRange] = useState({ start: 0, end: -1 });
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const heightOf = useCallback((i: number) => {
    const item = itemsRef.current[i];
    const known = measured.current.get(item);
    if (known !== undefined) return known;
    const held = reserved.current.get(item);
    if (held !== undefined) return held;
    reserved.current.set(item, estimate.current);
    return estimate.current;
  }, []);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || el.clientHeight === 0 || inPass.current) return;
    inPass.current = true;
    try {
      const rows = content.querySelectorAll<HTMLElement>("[data-msg-row]");
      const list = itemsRef.current;
      const n = Math.min(rows.length, list.length);
      if (n === 0) return;

      // Width and prose size change every row's height at once, so every
      // measurement taken under the old layout is worthless.
      const key = `${el.clientWidth}|${getComputedStyle(
        document.documentElement,
      ).getPropertyValue("--prose-size")}`;
      if (layoutKey.current !== key) {
        layoutKey.current = key;
        measured.current = new WeakMap();
        reserved.current = new WeakMap();
        estimate.current = SEED_ROW_HEIGHT;
      }

      const vh = el.clientHeight;
      const base = content.offsetTop;
      const paneTop = el.getBoundingClientRect().top;
      /** Where a row sits relative to the visible box, to sub-pixel accuracy.
       *  offsetTop is rounded to whole pixels, and a 1px error here is a visible
       *  jolt when everything on the page resizes at once. */
      const rowTop = (row: HTMLElement) =>
        row.getBoundingClientRect().top - paneTop;
      /** First row whose bottom edge is past `y`, in content coordinates. */
      const rowAt = (y: number) => {
        let lo = 0;
        let hi = n - 1;
        let ans = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const row = rows[mid];
          if (row.offsetTop - base + row.offsetHeight > y) {
            ans = mid;
            hi = mid - 1;
          } else lo = mid + 1;
        }
        return ans;
      };

      // A jump owns the scroll position outright. The target sits at an
      // estimated offset until the rows around it render, so re-pin it every
      // frame until those heights are real — one writer, converging, instead of
      // a smooth scroll racing the window.
      const goto = jump.current;
      if (goto) {
        const row = content.querySelector<HTMLElement>(
          `[data-msg-row="${CSS.escape(goto.uuid)}"]`,
        );
        if (row) el.scrollTop = row.offsetTop - base - JUMP_MARGIN;
        anchor.current = null;
        if (row && --goto.frames <= 0) jump.current = null;
        else if (!row) jump.current = null;
      }

      // Put the reader back where they were. Rows that just gained content are
      // rarely the height they reserved, and every row above the viewport that
      // changes moves the page under them. Restoring one known row is exact
      // whatever changed, and does not depend on catching every row.
      const hold = goto ? null : anchor.current;
      anchor.current = null;
      if (hold && hold.index < n) {
        // Carry any scrolling done by someone else since the anchor was taken —
        // a wheel, the restore-to-bottom on open, the overview rail. Without
        // this the anchor undoes their move and a chat opens at the top.
        //
        // But when the document shrinks the browser clamps scrollTop to the new
        // maximum, and that is layout, not intent. Counting it as a deliberate
        // move carries the whole collapse into the restore and lands the reader
        // thousands of px away — which is what opening find used to do.
        const clampLoss = Math.max(
          0,
          hold.at - (el.scrollHeight - el.clientHeight),
        );
        const moved = el.scrollTop - hold.at + clampLoss;
        // Measuring rows changes the document height, so "the bottom" moves. A
        // reader following the newest message stays there — but only if they
        // have not scrolled away since, or this would trap them at the bottom.
        const stillFollowing = hold.atBottom && Math.abs(moved) < 2;
        const raw = stillFollowing
          ? el.scrollHeight - el.clientHeight
          : el.scrollTop + (rowTop(rows[hold.index]) - hold.offset + moved);
        // Snap to the device pixel grid. The compositor snaps scrollTop anyway,
        // so an unsnapped target can never be reached and the correction
        // re-fires every frame, leaving a permanent half-pixel offset.
        const dpr = window.devicePixelRatio || 1;
        const want = Math.round(raw * dpr) / dpr;
        if (Math.abs(el.scrollTop - want) > 0.05) el.scrollTop = want;
      }
      const top = el.scrollTop;

      let changed = false;
      const prev = rangeRef.current;
      const measureRow = (i: number) => {
        const h = rows[i].offsetHeight;
        if (h <= 0) return;
        const was = measured.current.get(list[i]);
        if (was !== undefined && Math.abs(was - h) <= 0.5) return;
        measured.current.set(list[i], h);
        changed = true;
      };
      for (let i = prev.start; i <= Math.min(prev.end, n - 1); i++)
        measureRow(i);
      // Rows the indexer forced up are rendered too, so take their real height
      // while it is there. Otherwise the document changes when the slice
      // appears AND again when it is released, and the page dances.
      if (forceRange) {
        for (let i = forceRange.start; i < Math.min(forceRange.end, n); i++) {
          measureRow(i);
        }
      }
      if (changed) {
        // Mean, not median. This estimate reserves height for rows nobody has
        // visited and the document height is their SUM, so only the mean keeps
        // that sum unbiased — tool rows are ~33px against ~150px of prose.
        let sum = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
          const h = measured.current.get(list[i]);
          if (h !== undefined) {
            sum += h;
            count++;
          }
        }
        if (count > 0) estimate.current = sum / count;
      }
      const first = rowAt(top - RENDER_MARGIN * vh);
      const last = rowAt(top + vh + RENDER_MARGIN * vh);
      const keepFirst = rowAt(top - KEEP_MARGIN * vh);
      const keepLast = rowAt(top + vh + KEEP_MARGIN * vh);
      const start = Math.min(first, Math.max(prev.start, keepFirst));
      const end = Math.max(last, Math.min(prev.end, keepLast));
      if (goto) schedule.current();
      // Remember where the reader is, every pass. Anything that changes a row's
      // height before the next pass — the window moving, shiki resolving, find
      // rendering every row — is then undone against this. When nothing moved,
      // the restore above computes the same offset and writes nothing.
      if (!goto) {
        const at = rowAt(top);
        anchor.current = {
          index: at,
          offset: rowTop(rows[at]),
          at: top,
          atBottom: el.scrollHeight - top - vh < BOTTOM_EPSILON,
        };
      }
      // Frozen means the window holds still while the find indexer renders
      // slices all over the chat. The anchor above is still captured every
      // pass — without it that churn moves the page under the reader.
      if (!frozen && (start !== prev.start || end !== prev.end)) {
        setRange({ start, end });
      }
    } finally {
      inPass.current = false;
    }
  }, [scrollRef, contentRef, heightOf, frozen, forceRange]);

  const schedule = useRef<() => void>(() => {});
  schedule.current = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      sync();
    });
  }, [sync]);
  const scheduleStable = useCallback(() => schedule.current(), []);

  const scrollToRow = useCallback((uuid: string) => {
    jump.current = { uuid, frames: JUMP_SETTLE_FRAMES };
    schedule.current();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", scheduleStable, { passive: true });
    return () => {
      el.removeEventListener("scroll", scheduleStable);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollRef, scheduleStable]);

  const shows = useCallback(
    (i: number) =>
      (i >= range.start && i <= range.end) ||
      (forceRange !== null && i >= forceRange.start && i < forceRange.end),
    [range.start, range.end, forceRange],
  );
  const reserve = useCallback(
    (i: number) => ({ height: `${heightOf(i)}px` }),
    [heightOf],
  );

  return { shows, reserve, sync, schedule: scheduleStable, scrollToRow };
}
