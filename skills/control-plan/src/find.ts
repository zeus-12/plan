/**
 * Checks for the find widget. It is shared by every surface, so these take a
 * SurfaceSpec too — the same checks will run against the diff's find once it is
 * windowed.
 */

import type { Session } from "./cdp.ts";
import { sleep } from "./cdp.ts";
import type { SurfaceSpec } from "./surface.ts";

export interface FindToggleResult {
  frames: number;
  watchedRows: number;
  worstOnScreenTopShiftPx: number;
  worstOnScreenLeftShiftPx: number;
  worstRowHeightChangePx: number;
  totalTravelPx: number;
  framesThatMoved: number;
  paneMovedPx: number;
  docHeightRange: [number, number];
  PASS: boolean;
  error?: string;
}

/**
 * Open find, close it, and check nothing moved.
 *
 * Sampled every frame and across every visible row, not just before and after:
 * a shift lasting two frames is still a shift the eye catches, and a
 * settled-state check sails straight past it. Both axes, because furniture
 * appearing beside the surface moves content sideways.
 */
export async function findToggle(
  cdp: Session,
  s: SurfaceSpec,
  tolerancePx = 5,
  travelPx = 24,
): Promise<FindToggleResult> {
  const started = await cdp.evaluate<{
    watchedRows?: number;
    error?: string;
  }>(`(() => {
    const el = ${s.scroller};
    if (!el) return { error: "no visible ${s.name} surface" };
    const p = el.getBoundingClientRect();
    const watched = [...el.querySelectorAll("${s.row}")]
      .map((row) => ({ row, b: row.getBoundingClientRect() }))
      .filter((x) => x.b.bottom > p.top + 4 && x.b.top < p.bottom - 4 && (() => { const row = x.row; return ${s.filled}; })());
    if (!watched.length) return { error: "no rendered row inside the viewport" };
    window.__fRows = watched.map((x) => x.row);
    window.__fEl = el;
    window.__fSamples = [];
    const tick = () => {
      const pr = el.getBoundingClientRect();
      window.__fSamples.push({
        rows: window.__fRows.map((row) => {
          const b = row.getBoundingClientRect();
          return [+b.top.toFixed(1), +b.left.toFixed(1), Math.round(b.height)];
        }),
        paneTop: +pr.top.toFixed(1),
        scrollHeight: Math.round(el.scrollHeight),
      });
      window.__fRaf = requestAnimationFrame(tick);
    };
    window.__fRaf = requestAnimationFrame(tick);
    return { watchedRows: watched.length };
  })()`);
  if (started.error)
    return { ...(started as any), PASS: false } as FindToggleResult;

  await sleep(400);
  await cdp.key("f", { meta: true });
  await sleep(1800);
  await cdp.key("Escape");
  await sleep(1800);

  const r = await cdp.evaluate<any>(`(() => {
    cancelAnimationFrame(window.__fRaf);
    const frames = window.__fSamples;
    if (frames.length < 5) return { error: "too few frames" };
    const base = frames[0];
    let worstTop = 0, worstLeft = 0, worstHeight = 0, worstPane = 0;
    // A dance is many small moves, not one big one, so total travel and how
    // many frames moved matter as much as the worst single shift.
    let travel = 0, movedFrames = 0;
    frames.forEach((f, fi) => {
      worstPane = Math.max(worstPane, Math.abs(f.paneTop - base.paneTop));
      let frameMax = 0;
      f.rows.forEach((row, i) => {
        worstTop = Math.max(worstTop, Math.abs(row[0] - base.rows[i][0]));
        worstLeft = Math.max(worstLeft, Math.abs(row[1] - base.rows[i][1]));
        worstHeight = Math.max(worstHeight, Math.abs(row[2] - base.rows[i][2]));
        if (fi > 0) frameMax = Math.max(frameMax, Math.abs(row[0] - frames[fi-1].rows[i][0]));
      });
      if (fi > 0 && frameMax > 0.5) { travel += frameMax; movedFrames++; }
    });
    return {
      frames: frames.length,
      watchedRows: base.rows.length,
      worstOnScreenTopShiftPx: +worstTop.toFixed(1),
      worstOnScreenLeftShiftPx: +worstLeft.toFixed(1),
      worstRowHeightChangePx: worstHeight,
      totalTravelPx: Math.round(travel),
      framesThatMoved: movedFrames,
      paneMovedPx: +worstPane.toFixed(1),
      docHeightRange: [
        Math.min(...frames.map((f) => f.scrollHeight)),
        Math.max(...frames.map((f) => f.scrollHeight)),
      ],
    };
  })()`);

  return {
    ...r,
    PASS:
      r.worstOnScreenTopShiftPx <= tolerancePx &&
      r.worstOnScreenLeftShiftPx <= tolerancePx &&
      r.worstRowHeightChangePx <= tolerancePx &&
      r.totalTravelPx <= travelPx,
  };
}

export interface FindTypeResult {
  worstBlockedMs: number;
  counter: string;
  renderedRows: number | null;
}

/** Open find, wait out any first-time indexing, then type and time the frames. */
export async function findType(
  cdp: Session,
  s: SurfaceSpec,
  text = "en",
  indexWaitMs = 9000,
): Promise<FindTypeResult> {
  await cdp.key("f", { meta: true });
  await sleep(indexWaitMs);
  await cdp.evaluate(`(() => {
    window.__k = [];
    const tick = (t) => { window.__k.push(t); window.__kraf = requestAnimationFrame(tick); };
    window.__kraf = requestAnimationFrame(tick);
    return 1;
  })()`);
  await sleep(200);
  for (const ch of text) {
    await cdp.type(ch);
    await sleep(1200);
  }
  const r = await cdp.evaluate<FindTypeResult>(`(() => {
    cancelAnimationFrame(window.__kraf);
    const k = window.__k;
    let worst = 0;
    for (let i = 1; i < k.length; i++) worst = Math.max(worst, k[i] - k[i-1]);
    const el = ${s.scroller};
    const counter = [...document.querySelectorAll("span")].map((x) => x.textContent || "")
      .find((t) => /of |No results|Indexing/.test(t)) || "";
    return {
      worstBlockedMs: Math.round(worst),
      counter,
      renderedRows: el
        ? [...el.querySelectorAll("${s.row}")].filter((row) => ${s.filled}).length
        : null,
    };
  })()`);
  await cdp.key("Escape");
  return r;
}
