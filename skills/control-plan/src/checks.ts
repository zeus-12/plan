/**
 * The measurements, written once against a SurfaceSpec so chat and diff share
 * them.
 *
 * Correctness first. A blank surface passes every timing check ever written, so
 * `coverage` runs before any number is believed.
 */

import type { Session } from "./cdp.ts";
import { sleep } from "./cdp.ts";
import type { SurfaceSpec } from "./surface.ts";

/** Records a frame timeline in the page. A gap means the main thread was
 *  blocked OR the window went hidden; the report distinguishes them. */
const recorder = (s: SurfaceSpec) => `(() => {
  window.__cpVis = [];
  window.__cpOnVis = () => window.__cpVis.push(document.hidden);
  document.addEventListener("visibilitychange", window.__cpOnVis);
  window.__cpFrames = [];
  const tick = (t) => {
    const el = ${s.scroller};
    window.__cpFrames.push([t, el ? el.querySelectorAll("${s.row}").length : 0]);
    window.__cpRaf = requestAnimationFrame(tick);
  };
  window.__cpT0 = performance.now();
  window.__cpRaf = requestAnimationFrame(tick);
  return 1;
})()`;

const REPORT = `(() => {
  cancelAnimationFrame(window.__cpRaf);
  document.removeEventListener("visibilitychange", window.__cpOnVis);
  const m = window.__cpFrames;
  let worst = 0, worstAt = 0, over100 = 0;
  for (let i = 1; i < m.length; i++) {
    const dt = m[i][0] - m[i-1][0];
    if (dt > 100) over100++;
    if (dt > worst) { worst = dt; worstAt = m[i][0] - window.__cpT0; }
  }
  return {
    VALID: !window.__cpVis.some(Boolean) && !document.hidden,
    frames: m.length,
    rows: m[m.length - 1][1],
    longestBlockedMs: Math.round(worst),
    longestBlockedAtMs: Math.round(worstAt),
    framesOver100ms: over100,
  };
})()`;

export interface OpenResult {
  VALID: boolean;
  rows: number;
  longestBlockedMs: number;
  longestBlockedAtMs: number;
  framesOver100ms: number;
}

/** Cost of the click that brings a surface up. */
export async function measureOpen(
  cdp: Session,
  spec: SurfaceSpec,
  target: { x: number; y: number },
  watchMs = 7000,
): Promise<OpenResult> {
  await cdp.evaluate(recorder(spec));
  await cdp.click(target.x, target.y);
  await sleep(watchMs);
  return cdp.evaluate<OpenResult>(REPORT);
}

export interface CoverageResult {
  rows: number;
  renderedRows: number;
  viewportRows: number;
  emptyInViewport: number;
  scrollTop: number;
  scrollHeight: number;
  PASS: boolean;
  error?: string;
}

/** Every row intersecting the visible box must hold real content. */
export async function coverage(
  cdp: Session,
  s: SurfaceSpec,
): Promise<CoverageResult> {
  return cdp.evaluate<CoverageResult>(`(() => {
    const el = ${s.scroller};
    if (!el) return { error: "no visible ${s.name} surface", PASS: false };
    const rows = [...el.querySelectorAll("${s.row}")];
    if (!rows.length) return { error: "no rows", PASS: false };
    const base = rows[0].parentElement.offsetTop;
    const top = el.scrollTop, bottom = top + el.clientHeight;
    let inView = 0, empty = 0, filled = 0;
    for (const row of rows) {
      if (${s.filled}) filled++;
      const t = row.offsetTop - base;
      if (t + row.offsetHeight <= top || t >= bottom) continue;
      inView++;
      if (!(${s.filled}) || row.offsetHeight === 0) empty++;
    }
    return {
      rows: rows.length, renderedRows: filled,
      viewportRows: inView, emptyInViewport: empty,
      scrollTop: Math.round(top), scrollHeight: Math.round(el.scrollHeight),
      PASS: empty === 0 && inView > 0,
    };
  })()`);
}

export interface DriftResult {
  commandedPx?: number;
  anchorTravelledPx?: number;
  visibleDriftPx?: number;
  reversals?: number;
  docGrowthPx?: number;
  clamped?: boolean;
  skipped?: string;
  roomPx?: number;
  error?: string;
}

/**
 * Does the content the reader is looking at travel the distance the gesture
 * asked for?
 *
 * scrollTop totals and document growth are the wrong measure: measuring rows
 * legitimately changes the document height, and correcting for that shows up in
 * those numbers as if it were damage. Only the anchor row's on-screen travel
 * says what the reader saw.
 */
export async function drift(
  cdp: Session,
  s: SurfaceSpec,
  { steps = 25, delta = -200, gap = 45 } = {},
): Promise<DriftResult> {
  // Only scroll as far as there is room: a gesture that runs into the end stops
  // early, and grading it against the full commanded distance reports a huge
  // "drift" that is really just the end of the document.
  const room = await cdp.evaluate<number | null>(`(() => {
    const el = ${s.scroller};
    if (!el) return null;
    return ${delta} < 0
      ? Math.max(0, el.scrollTop)
      : Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  })()`);
  if (room === null) return { error: `no visible ${s.name} surface` };
  const usable = Math.min(steps, Math.floor((room - 40) / Math.abs(delta)));
  if (usable < 5)
    return { skipped: "not enough room to scroll", roomPx: Math.round(room) };
  const commanded = usable * Math.abs(delta);

  const geom = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = ${s.scroller};
    if (!el) return null;
    const paneTop = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll("${s.row}")];
    if (!rows.length) return null;
    const mid = el.clientHeight / 2;
    let best = Infinity, anchor = null;
    for (const row of rows) {
      const b = row.getBoundingClientRect();
      const d = Math.abs((b.top + b.bottom) / 2 - paneTop - mid);
      if (d < best) { best = d; anchor = row; }
    }
    window.__cpS = [];
    const tick = () => {
      window.__cpS.push([el.scrollTop, anchor.getBoundingClientRect().top, el.scrollHeight]);
      window.__cpAraf = requestAnimationFrame(tick);
    };
    window.__cpAraf = requestAnimationFrame(tick);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!geom) return { error: "no anchor row" };

  await sleep(100);
  for (let i = 0; i < usable; i++) {
    await cdp.wheel(geom.x, geom.y, delta);
    await sleep(gap);
  }
  await sleep(1000);

  return cdp.evaluate<DriftResult>(`(() => {
    cancelAnimationFrame(window.__cpAraf);
    const s = window.__cpS;
    if (s.length < 2) return { error: "no samples" };
    let reversals = 0;
    const dir = Math.sign(s[s.length-1][0] - s[0][0]) || 1;
    for (let i = 1; i < s.length; i++) {
      const d = s[i][0] - s[i-1][0];
      if (d !== 0 && Math.sign(d) !== dir) reversals++;
    }
    const el = ${s.scroller};
    const travelled = s[s.length-1][1] - s[0][1];
    return {
      commandedPx: ${commanded},
      anchorTravelledPx: Math.round(travelled),
      visibleDriftPx: Math.round(travelled - ${commanded}),
      reversals,
      clamped: el.scrollTop <= 1 || el.scrollTop >= el.scrollHeight - el.clientHeight - 1,
      docGrowthPx: Math.round(s[s.length-1][2] - s[0][2]),
    };
  })()`);
}
