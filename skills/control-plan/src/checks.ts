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

export interface JumpResult {
  frames: number;
  blankFrames: number;
  firstFramePct: number;
  worstPct: number;
  error?: string;
}

/**
 * Fling far up the document and watch what gets painted.
 *
 * A windowed surface that picks its rows a frame late paints one frame of empty
 * boxes — the black band you see after a fast scroll. Sampling after the scroll
 * settles cannot see it, so this samples the covered fraction of the viewport
 * every frame across the jump.
 */
export async function jumpBlank(
  cdp: Session,
  s: SurfaceSpec,
  distancePx = 40000,
): Promise<JumpResult> {
  const started = await cdp.evaluate<{ error?: string }>(`(() => {
    const el = ${s.scroller};
    if (!el) return { error: "no visible ${s.name} surface" };
    window.__cpJ = [];
    const tick = () => {
      const pr = el.getBoundingClientRect();
      let covered = 0;
      for (const row of el.querySelectorAll("${s.row}")) {
        if (!(${s.filled})) continue;
        const b = row.getBoundingClientRect();
        const top = Math.max(b.top, pr.top), bot = Math.min(b.bottom, pr.bottom);
        if (bot > top) covered += bot - top;
      }
      // Capped: split view lays two columns down one scroller, so every band of
      // viewport is covered twice and the raw sum reads 200%.
      window.__cpJ.push(Math.min(100, Math.round((covered / pr.height) * 100)));
      window.__cpJraf = requestAnimationFrame(tick);
    };
    window.__cpJraf = requestAnimationFrame(tick);
    el.scrollTop = Math.max(0, el.scrollTop - ${distancePx});
    return {};
  })()`);
  if (started.error)
    return {
      ...(started as any),
      frames: 0,
      blankFrames: 0,
      firstFramePct: 0,
      worstPct: 0,
    };
  await sleep(2500);
  return cdp.evaluate<JumpResult>(`(() => {
    cancelAnimationFrame(window.__cpJraf);
    const j = window.__cpJ;
    if (!j.length) return { error: "no frames", frames: 0, blankFrames: 0, firstFramePct: 0, worstPct: 0 };
    return {
      frames: j.length,
      blankFrames: j.filter((x) => x < 50).length,
      firstFramePct: j[0],
      worstPct: Math.min(...j),
    };
  })()`);
}

export interface ParkResult {
  frames: number;
  distinctTopRows: number;
  scrollTopMoved: number;
  topRowOffsetDrift: number;
  docHeightChanged: number;
  error?: string;
}

/** Start watching the row under the viewport's top edge. */
export async function parkWatch(cdp: Session, s: SurfaceSpec): Promise<void> {
  await cdp.evaluate(`(() => {
    const el = ${s.scroller};
    if (!el) return;
    window.__cpP = [];
    const top = () => {
      const pr = el.getBoundingClientRect();
      const hit = [...el.querySelectorAll("${s.row}")]
        .map((row) => ({ row, t: row.getBoundingClientRect().top - pr.top }))
        .filter((x) => x.t > -4).sort((a, b) => a.t - b.t)[0];
      return hit ? { u: hit.row.getAttribute("${s.rowKey}") || "?", t: Math.round(hit.t) } : { u: "-", t: 0 };
    };
    const tick = () => {
      const x = top();
      window.__cpP.push([Math.round(el.scrollTop), x.u, x.t, Math.round(el.scrollHeight)]);
      window.__cpPraf = requestAnimationFrame(tick);
    };
    window.__cpPraf = requestAnimationFrame(tick);
  })()`);
}

export interface FoldResult {
  foldedAtRow?: string;
  anchorRow?: string;
  anchorOffsetBefore?: number;
  anchorOffsetAfter?: number;
  anchorMovedPx?: number;
  scrollTopBefore?: number;
  scrollTopAfter?: number;
  rowsRemoved?: number;
  PASS?: boolean;
  skipped?: string;
  error?: string;
}

/**
 * Collapse a fold and check the reader stays where they were.
 *
 * Folding renumbers every row below the fold. A window that keeps its measured
 * heights by position rather than by row loses all of them at once, and the
 * reader is thrown hundreds of lines back up the file — which is what folding a
 * function at line 1400 and landing near 1100 looks like.
 *
 * The fold clicked is the LAST one in view, so the collapse happens below the
 * reader: whatever it does to the rows underneath, the row at the top of the
 * viewport must not move.
 */
export async function foldHold(
  cdp: Session,
  s: SurfaceSpec,
): Promise<FoldResult> {
  const before = await cdp.evaluate<FoldResult>(`(() => {
    const el = ${s.scroller};
    if (!el) return { error: "no visible ${s.name} surface" };
    const pr = el.getBoundingClientRect();
    const inView = (b) => b.top >= pr.top && b.bottom <= pr.bottom;
    const folds = [...el.querySelectorAll('button[aria-label="Collapse region"]')]
      .filter((b) => inView(b.getBoundingClientRect()));
    if (folds.length === 0) return { skipped: "no collapsible region in view" };
    const anchor = [...el.querySelectorAll("${s.row}")]
      .map((row) => ({ row, t: row.getBoundingClientRect().top - pr.top }))
      .filter((x) => x.t > -4).sort((a, b) => a.t - b.t)[0];
    if (!anchor) return { skipped: "no anchor row" };
    const target = folds[folds.length - 1];
    const tr = target.closest("tr");
    const b = target.getBoundingClientRect();
    window.__cpFold = {
      anchorRow: anchor.row.getAttribute("${s.rowKey}"),
      anchorOffsetBefore: Math.round(anchor.t),
      foldedAtRow: tr ? tr.getAttribute("${s.rowKey}") : "?",
      scrollTopBefore: Math.round(el.scrollTop),
      rowsBefore: el.querySelectorAll("${s.row}").length,
    };
    return { ...window.__cpFold,
      x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (before.error || before.skipped) return before;

  const at = before as unknown as { x: number; y: number };
  await cdp.click(at.x, at.y);
  await sleep(700);

  return cdp.evaluate<FoldResult>(`(() => {
    const el = ${s.scroller};
    const f = window.__cpFold;
    const pr = el.getBoundingClientRect();
    const row = el.querySelector('${s.row}[${s.rowKey}="' + f.anchorRow + '"]');
    if (!row) return { ...f, error: "anchor row is gone — the fold swallowed the reader", PASS: false };
    const after = Math.round(row.getBoundingClientRect().top - pr.top);
    const moved = after - f.anchorOffsetBefore;
    return {
      anchorRow: f.anchorRow, foldedAtRow: f.foldedAtRow,
      anchorOffsetBefore: f.anchorOffsetBefore, anchorOffsetAfter: after,
      anchorMovedPx: moved,
      scrollTopBefore: f.scrollTopBefore, scrollTopAfter: Math.round(el.scrollTop),
      rowsRemoved: f.rowsBefore - el.querySelectorAll("${s.row}").length,
      PASS: Math.abs(moved) <= 4,
    };
  })()`);
}

export interface SettleResult {
  foldedAtRow?: string;
  anchorRow?: string;
  frames?: number;
  /** Furthest the reader's row ever got from where it started, at any frame. */
  excursionPx?: number;
  /** Direction changes along that path. One settle step is 0. */
  reversals?: number;
  distinctOffsets?: number;
  /** Where it ended up — what `foldHold` measures on its own. */
  restPx?: number;
  settleMs?: number;
  offsetPath?: number[];
  scrollTopPath?: number[];
  PASS?: boolean;
  skipped?: string;
  error?: string;
}

/**
 * Collapse a fold and watch the reader's row on **every frame**, not once it is
 * over.
 *
 * `foldHold` asks where the row ended up, and a view that lurches up and then
 * comes back answers that question perfectly. The complaint — "it bounces, up by
 * a thing then down by a thing" — is about the frames in between, so this
 * samples the path and fails on the largest departure along it.
 *
 * `where` picks which region collapses, relative to the reader:
 *
 * - `top` is the gesture a person actually makes. You click a chevron you can
 *   see, near the top of what you are reading, and the body of the function
 *   disappears from under your eyes. The fold's own start row survives, and it
 *   is the row your eye is on, so it must not move at all.
 * - `below` collapses the last region in view — far from the reader, and the
 *   cheap case.
 * - `above` collapses off-screen, which is the only one that has to move
 *   `scrollTop` to hold the row still, so a correction applied twice shows up
 *   there. A region that starts above the viewport can end inside it and take
 *   the reader's row with it; that is the fold working, not a fault, and it is
 *   reported as skipped.
 */
export async function foldSettle(
  cdp: Session,
  s: SurfaceSpec,
  where: "top" | "below" | "above" = "top",
): Promise<SettleResult> {
  const armed = await cdp.evaluate<SettleResult & { x?: number; y?: number }>(
    `(() => {
    const el = ${s.scroller};
    if (!el) return { error: "no visible ${s.name} surface" };
    const pr = el.getBoundingClientRect();
    const where = ${JSON.stringify(where)};
    const folds = [...el.querySelectorAll('button[aria-label="Collapse region"]')]
      .map((b) => ({ b, r: b.getBoundingClientRect() }));
    const inView = folds.filter((f) => f.r.top >= pr.top && f.r.bottom <= pr.bottom);
    const pick =
      where === "above" ? folds.filter((f) => f.r.bottom < pr.top).pop()
      : where === "top" ? inView[0]
      : inView.pop();
    if (!pick) return { skipped: "no collapsible region " + where + " the reader" };

    const foldRow = pick.b.closest("tr");
    // For the real gesture the reader's eye is on the line being folded, so that
    // row is the anchor. Otherwise it is the topmost row not about to close.
    const anchor = where === "top"
      ? { row: foldRow, t: foldRow.getBoundingClientRect().top - pr.top }
      : [...el.querySelectorAll("${s.row}")]
          .map((row) => ({ row, t: row.getBoundingClientRect().top - pr.top }))
          .filter((x) => x.t > -4 && x.row !== foldRow)
          .sort((a, b) => a.t - b.t)[0];
    if (!anchor || !anchor.row) return { skipped: "no anchor row" };

    const key = anchor.row.getAttribute("${s.rowKey}");
    window.__cpS = { key, t0: performance.now(), o: [], st: [] };
    const tick = () => {
      const p = el.getBoundingClientRect();
      const row = el.querySelector('${s.row}[${s.rowKey}="' + key + '"]');
      window.__cpS.o.push(row ? Math.round(row.getBoundingClientRect().top - p.top) : null);
      window.__cpS.st.push(Math.round(el.scrollTop));
      window.__cpS.raf = requestAnimationFrame(tick);
    };
    window.__cpS.raf = requestAnimationFrame(tick);
    window.__cpS.foldedAtRow = foldRow ? foldRow.getAttribute("${s.rowKey}") : "?";
    return {
      anchorRow: key, foldedAtRow: window.__cpS.foldedAtRow,
      x: Math.round(pick.r.left + pick.r.width / 2),
      y: Math.round(pick.r.top + pick.r.height / 2),
    };
  })()`,
  );
  if (armed.error || armed.skipped) return armed;

  // An off-screen fold still has to be clicked. Above the viewport there are no
  // coordinates to click, so drive the button directly.
  if (where === "above")
    await cdp.evaluate(`(() => {
      const el = ${s.scroller};
      const pr = el.getBoundingClientRect();
      const b = [...el.querySelectorAll('button[aria-label="Collapse region"]')]
        .filter((x) => x.getBoundingClientRect().bottom < pr.top).pop();
      if (b) b.click();
    })()`);
  else await cdp.click(armed.x as number, armed.y as number);
  await sleep(1200);

  return cdp.evaluate<SettleResult>(`(() => {
    cancelAnimationFrame(window.__cpS.raf);
    const s = window.__cpS;
    const o = s.o.filter((x) => x !== null);
    // The region reached down past the reader and closed over their row. That is
    // the fold doing its job; where they land instead is foldHold's question.
    if (o.length < 2) return { skipped: "the region closed over the reader's row", anchorRow: s.key, foldedAtRow: s.foldedAtRow };
    const start = o[0];
    let excursion = 0, reversals = 0, dir = 0, settleAt = 0;
    for (let i = 1; i < o.length; i++) {
      const d = o[i] - o[i - 1];
      excursion = Math.max(excursion, Math.abs(o[i] - start));
      if (Math.abs(d) > 1) {
        settleAt = i;
        const sign = Math.sign(d);
        if (dir !== 0 && sign !== dir) reversals++;
        dir = sign;
      }
    }
    return {
      anchorRow: s.key, foldedAtRow: s.foldedAtRow,
      frames: o.length,
      excursionPx: excursion,
      reversals,
      distinctOffsets: new Set(o).size,
      restPx: o[o.length - 1] - start,
      settleMs: Math.round((settleAt / o.length) * (performance.now() - s.t0)),
      offsetPath: o.slice(0, 24),
      scrollTopPath: s.st.slice(0, 24),
      PASS: excursion <= 4,
    };
  })()`);
}

/** Stop watching and report whether anything moved under the reader. */
export async function parkReport(cdp: Session): Promise<ParkResult> {
  return cdp.evaluate<ParkResult>(`(() => {
    cancelAnimationFrame(window.__cpPraf);
    const p = window.__cpP;
    if (!p || p.length < 2) return { error: "no samples", frames: 0, distinctTopRows: 0, scrollTopMoved: 0, topRowOffsetDrift: 0, docHeightChanged: 0 };
    return {
      frames: p.length,
      distinctTopRows: new Set(p.map((x) => x[1])).size,
      scrollTopMoved: p[p.length-1][0] - p[0][0],
      topRowOffsetDrift: p[p.length-1][2] - p[0][2],
      docHeightChanged: p[p.length-1][3] - p[0][3],
    };
  })()`);
}
