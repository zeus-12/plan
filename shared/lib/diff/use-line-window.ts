import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

/** Rows within this many viewports of the visible box are rendered. */
const RENDER_MARGIN = 1.5;
/** A rendered row stays rendered until it is this far out, so a small
 *  oscillating scroll can't thrash the rows at the edge of the window. */
const KEEP_MARGIN = 3;

export interface LineWindow {
  /** First and last position in `keys` to render, inclusive. */
  first: number;
  last: number;
  /** Height to reserve above `first` and below `last`, in px. */
  padTop: number;
  padBottom: number;
  /** Put position `index` on screen, whether or not it is rendered. */
  reveal: (index: number) => void;
}

/**
 * Renders only the rows near the viewport.
 *
 * A diff with "All lines" on renders every line of the file: a 3,000-line file
 * becomes 12,000 row elements and ~96,000 nodes, and from there a single forced
 * layout costs 816ms — which is what made the comment popover slow, since it
 * ends with one `getBoundingClientRect()`. Measured against rendered rows the
 * cost is linear: 6,000 rows 818ms, 500 rows 80ms, 200 rows 42ms.
 *
 * Every row's height is measured and kept, under the row's own key rather than
 * its position. Two things break a window built on position instead:
 *
 * - One average pitch is not enough. With line wrap the rows are different
 *   heights, and an average over the rendered band is a function of where the
 *   band is; the band then moves the average, the average moves the reserved
 *   space, the reserved space moves the band. A measured height is a fact about
 *   a row, so it cannot feed back.
 * - Collapsing a fold renumbers every row below it. Heights held by position
 *   are all wrong at once, and the reader is thrown somewhere else in the file.
 *
 * `keys` gives each visible row its identity and its order; `generation` says
 * when those keys start meaning something else, and heights are dropped.
 */
export function useLineWindow(
  /** The element that actually scrolls. The diff resolves it at runtime, so it
   *  arrives as an element rather than a ref. */
  scroller: HTMLElement | null,
  /** One stable key per row that would render, in document order. Folding
   *  removes entries; it must not renumber the ones that remain. */
  keys: number[],
  /** Identity of the content the keys index into. A new one drops every
   *  measurement, because key 500 now names a different row. */
  generation: unknown,
  /**
   * Anything that changes how tall a row renders without changing which row it
   * is — font size, line wrap, an inline comment appearing. A new value forces
   * every rendered row to be measured again; without one, typing in find would
   * re-measure hundreds of rows per keystroke for no reason.
   */
  layoutToken: unknown,
  /** Attribute carrying a row's key. Unified and split share one scroller, so
   *  each needs its own name or one view measures the other's rows. */
  rowAttr: string,
  /**
   * Whether this view is the one on screen. Both views are hooks, so both run
   * on every render; the one that is not mounted must not touch the scroll,
   * because its idea of where a row sits describes a document nobody is
   * looking at.
   */
  active: boolean,
  /** Height to assume for a row nobody has measured yet. */
  estimatedRowHeight = 20,
): LineWindow {
  const [range, setRange] = useState({ first: 0, last: 0 });
  /**
   * Bumped whenever the reserved heights change, purely to force a render.
   *
   * `padTop` is computed from the prefix during render, so the document only
   * agrees with the prefix as of the last render. Rebuilding the prefix in a
   * layout effect and not rendering leaves the two describing different
   * documents, and every correction made against one is wrong in the other.
   */
  const [, bumpPrefix] = useState(0);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const heights = useRef(new Map<number, number>());
  /** Running total and count of the rows measured so far. An unmeasured row is
   *  reserved at this mean, which converges instead of tracking the viewport. */
  const measuredTotal = useRef(0);
  const measuredCount = useRef(0);

  const prefix = useRef<number[]>([0]);
  const position = useRef(new Map<number, number>());
  const order = useRef<number[]>([]);
  /** Where the reader is, in terms of a row rather than a pixel. */
  const anchor = useRef<{ key: number; offset: number } | null>(null);
  const restorePending = useRef(false);
  const generationRef = useRef(generation);
  const layoutRef = useRef(layoutToken);
  const keysRef = useRef<number[] | null>(null);
  /** Measure every rendered row, not just the ones never seen. */
  const remeasureAll = useRef(true);
  /** Whether a window has ever been picked for this scroller. */
  const placed = useRef(false);
  /** Passes spent chasing a restore, so a pathological one cannot spin. */
  const restoreTries = useRef(0);

  /** Width the stored heights were measured at. Only a width change rewraps. */
  const measuredWidth = useRef(0);

  const count = keys.length;

  const rebuild = useCallback(() => {
    const h = heights.current;
    const est =
      measuredCount.current > 0
        ? measuredTotal.current / measuredCount.current
        : estimatedRowHeight;
    const out = new Array<number>(count + 1);
    let acc = 0;
    for (let i = 0; i < count; i++) {
      out[i] = acc;
      acc += h.get(keys[i]) ?? est;
    }
    out[count] = acc;
    prefix.current = out;
  }, [keys, count, estimatedRowHeight]);

  // During render, not in an effect: the spacer heights this call returns are
  // committed to the DOM straight away, and an effect would leave one frame
  // where the document is the wrong height and the browser clamps the scroll.
  const forget = useCallback(() => {
    heights.current = new Map();
    measuredTotal.current = 0;
    measuredCount.current = 0;
    remeasureAll.current = true;
  }, []);
  let dirty = false;
  if (generationRef.current !== generation) {
    generationRef.current = generation;
    forget();
    anchor.current = null;
    dirty = true;
  }
  if (layoutRef.current !== layoutToken) {
    layoutRef.current = layoutToken;
    // Every height, not just the rendered ones. Turning wrap on re-measures
    // what is on screen, but a row measured at 22px before the toggle is still
    // reserved at 22px when it scrolls back into view — and 11 of those is the
    // reader landing 242px away from where they were.
    forget();
    // Their row is still their row, though, so hold it across the change.
    restorePending.current = anchor.current !== null;
    dirty = true;
  }
  if (keysRef.current !== keys) {
    // A fold collapsed or expanded. The surviving rows keep their keys, so they
    // keep their heights, and the reader keeps their place.
    restorePending.current =
      keysRef.current !== null && anchor.current !== null;
    keysRef.current = keys;
    position.current = new Map(keys.map((k, i) => [k, i]));
    dirty = true;
  }
  if (dirty) rebuild();

  /** Last row starting at or before `y`. */
  const indexAt = useCallback((y: number) => {
    const p = prefix.current;
    if (p.length < 2) return 0;
    let lo = 0;
    let hi = p.length - 2;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid] <= y) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }, []);

  /** Pick the window from the current scroll offset, and remember which row the
   *  reader is on. Reads no geometry beyond the scroller, so it is safe to run
   *  on every scroll event. */
  const place = useCallback(
    (canFlush = false) => {
      const el = scroller;
      if (!el || count === 0 || !active) return;

      const vh = el.clientHeight || 1;
      const top = el.scrollTop;

      const at = indexAt(top);
      anchor.current = {
        key: keys[at],
        offset: top - (prefix.current[at] ?? 0),
      };

      const firstWanted = indexAt(top - RENDER_MARGIN * vh);
      const lastWanted = indexAt(top + vh + RENDER_MARGIN * vh);
      const firstKeep = indexAt(top - KEEP_MARGIN * vh);
      const lastKeep = Math.min(
        count - 1,
        indexAt(top + vh + KEEP_MARGIN * vh),
      );

      const prev = rangeRef.current;
      // Re-render only when the viewport leaves the band already rendered, and
      // then re-arm with the wider keep band. Nudging the window every frame
      // instead means React reconciles ~500 rows on every frame of a scroll,
      // which is smooth-looking arithmetic and a janky scroll.
      const covered =
        prev.last > prev.first &&
        firstWanted >= prev.first &&
        lastWanted <= prev.last;
      if (covered) return;
      if (firstKeep === prev.first && lastKeep === prev.last) return;
      rangeRef.current = { first: firstKeep, last: lastKeep };
      // A jump clean out of the rendered band — a fling, a scrollbar drag, find
      // landing on a match — has nothing to show until the new rows exist. Left
      // to React's own scheduling that is one painted frame of empty spacers:
      // the black band. Commit it before the browser gets to paint.
      const jumped = firstKeep > prev.last || lastKeep < prev.first;
      if (jumped && canFlush) flushSync(() => setRange(rangeRef.current));
      else setRange(rangeRef.current);
    },
    [scroller, keys, count, indexAt, active],
  );

  /** Put the reader back on the row they were on. */
  const restore = useCallback(() => {
    const el = scroller;
    const a = anchor.current;
    if (!el || !a) return;

    let at = position.current.get(a.key);
    let offset = a.offset;
    if (at === undefined) {
      // Their row was inside the fold that just closed. Land on the nearest row
      // above it that survived — in practice the fold's own start row.
      for (let j = order.current.indexOf(a.key) - 1; j >= 0; j--) {
        const found = position.current.get(order.current[j]);
        if (found !== undefined) {
          at = found;
          offset = 0;
          break;
        }
      }
    }
    if (at === undefined) return;
    const want = (prefix.current[at] ?? 0) + offset;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(max, Math.max(0, want));
  }, [scroller]);

  /** Measure what is rendered, then place. Runs after a render, not on scroll:
   *  reading every rendered row costs a layout, and renders are rare next to
   *  scroll events. */
  const measure = useCallback(() => {
    const el = scroller;
    if (!el || count === 0 || !active) return;

    const restored = restorePending.current;
    restorePending.current = false;

    const prev = rangeRef.current;
    const before = prefix.current[Math.min(prev.first, count)] ?? 0;

    // A key can own several elements: its own row plus any inline comment rows
    // under it. Those add up. Split view then repeats the whole set in a second
    // table, and there the taller column decides.
    //
    // A row already measured is skipped without reading its geometry. Typing in
    // find re-renders the diff on every keystroke, and measuring every rendered
    // row each time costs a full layout per character.
    const full = remeasureAll.current;
    remeasureAll.current = false;
    const seen = new Map<number, number>();
    for (const table of el.querySelectorAll("table")) {
      const column = new Map<number, HTMLElement[]>();
      for (const node of table.querySelectorAll<HTMLElement>(`[${rowAttr}]`)) {
        const key = Number(node.getAttribute(rowAttr));
        if (!Number.isInteger(key)) continue;
        if (!full && heights.current.has(key)) continue;
        const group = column.get(key);
        if (group) group.push(node);
        else column.set(key, [node]);
      }
      for (const [key, nodes] of column) {
        let h = 0;
        for (const node of nodes) h += node.getBoundingClientRect().height;
        if (h > 0) seen.set(key, Math.max(seen.get(key) ?? 0, h));
      }
    }

    let changed = false;
    for (const [key, h] of seen) {
      const was = heights.current.get(key);
      if (was !== undefined && Math.abs(was - h) <= 0.5) continue;
      heights.current.set(key, h);
      measuredTotal.current += h - (was ?? 0);
      if (was === undefined) measuredCount.current++;
      changed = true;
    }
    if (changed) {
      rebuild();
      bumpPrefix((n) => n + 1);
    }

    // Both of these put the reader back, and only one can be right.
    //
    // After a fold the reader is placed by ROW, and it has to happen here
    // rather than before the measuring: rows nobody has measured are reserved
    // at the mean of the ones that have, so the pass above moves every one of
    // them, and a restore done before it lands on an offset that no longer
    // exists — 2,971px out on a wrapped file.
    //
    // Otherwise the reader is held by PIXEL: rows above the window that turned
    // out taller or shorter than their reservation would slide the page, so
    // that difference is absorbed here, before paint.
    if (restored) {
      restore();
      // Keep holding the row until the reserved heights stop moving. Each pass
      // that measures rows nobody had measured shifts every unmeasured row
      // with it, so one restore lands on an offset the next pass invalidates —
      // 242px of residual on a wrapped file.
      restorePending.current = changed && restoreTries.current++ < 8;
      if (!restorePending.current) restoreTries.current = 0;
    } else if (changed) {
      const delta = (prefix.current[Math.min(prev.first, count)] ?? 0) - before;
      if (Math.abs(delta) > 0.5 && el.scrollTop > 0) {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(max, Math.max(0, el.scrollTop + delta));
      }
    }
    order.current = keys;

    // `place` reads scrollTop, which flushes layout. A render that changed
    // neither the rows nor the scroll — every keystroke in find is one —
    // cannot have moved the window, so it must not pay for one.
    if (changed || full || restored || !placed.current) {
      placed.current = true;
      place();
    }
  }, [scroller, keys, count, rowAttr, rebuild, place, restore, active]);

  // After every render: new rows have just been committed and nothing else
  // knows their heights. A dependency list would miss the renders that change a
  // row's height without changing the window — turning line wrap on is one.
  useLayoutEffect(measure);

  /**
   * The listener and the observer below have to outlive the callbacks they
   * call. `measure` is rebuilt whenever `keys` changes — that is every fold —
   * and re-running the effect means calling `observe()` again, which delivers a
   * callback immediately whether or not anything resized. That callback threw
   * away every measured height and restored from the re-estimate, one frame
   * after the fold had already painted: the reader lurched 829px and came back.
   */
  const live = useRef({ place, measure });
  live.current = { place, measure };

  useEffect(() => {
    const el = scroller;
    if (!el || !active) return;
    // Synchronously, not on the next frame: a fling can cover the whole
    // rendered band in one event, and deferring by a frame shows a blank band.
    // This hook holds the reader's place itself, by row. Chrome's own scroll
    // anchoring does the same job from a node it picks, and the two corrections
    // add up: collapsing a fold moved the reader 242px with both running.
    const hadAnchor = el.style.overflowAnchor;
    el.style.overflowAnchor = "none";
    const onScroll = () => live.current.place(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    // Only a width change rewraps a row, so only a width change invalidates a
    // measurement. Comparing against the width the heights were taken at rather
    // than against the previous callback's means a resize that happened while
    // this view was hidden is still caught the moment it comes back.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === measuredWidth.current) return;
      measuredWidth.current = el.clientWidth;
      forget();
      restorePending.current = anchor.current !== null;
      live.current.measure();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.style.overflowAnchor = hadAnchor;
      ro.disconnect();
    };
  }, [scroller, active, forget]);

  // `scrollIntoView` cannot reach a row that is not rendered, so jump by
  // arithmetic instead. The first pass puts the row in the window at its
  // reserved offset; the second runs once it has been measured, and lands on
  // its real offset.
  const reveal = useCallback(
    (index: number) => {
      const el = scroller;
      if (!el) return;
      const centre = () => {
        const target =
          (prefix.current[Math.min(index, count)] ?? 0) - el.clientHeight / 2;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(max, Math.max(0, target));
        place(true);
      };
      centre();
      requestAnimationFrame(centre);
    },
    [scroller, count, place],
  );

  const first = Math.min(range.first, Math.max(0, count - 1));
  const last = Math.min(range.last, Math.max(0, count - 1));

  // A host is not required to provide its own overflow container. The web diff
  // page, for example, scrolls with the document. In that case there is no
  // element whose local scrollTop this hook can use, so render the complete
  // row set instead of leaving the window at its initial single-row range.
  // The desktop still takes the virtualized path through its overflow pane.
  if (!scroller) {
    return {
      first: 0,
      last: Math.max(0, count - 1),
      padTop: 0,
      padBottom: 0,
      reveal,
    };
  }

  const p = prefix.current;
  const doc = p[count] ?? 0;
  return {
    first,
    last,
    padTop: p[first] ?? 0,
    padBottom: Math.max(0, doc - (p[last + 1] ?? doc)),
    reveal,
  };
}
