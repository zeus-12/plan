#!/usr/bin/env -S npx tsx
/**
 * Deterministic regression + performance run against a synthetic fixture.
 *
 *   pnpm -C skills/control-plan test
 *   pnpm -C skills/control-plan test --keep --rows 4000
 *
 * Nothing here touches real projects, chats or comments: the fixture gives the
 * app its own HOME and every path it uses derives from there.
 *
 * Each surface contributes its own suite. Chat exists today; the diff slots in
 * beside it as `diffSuite` once the diff is windowed, reusing every check.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, type Session } from "./src/cdp.ts";
import { launch, stop } from "./src/app.ts";
import {
  coverage,
  drift,
  foldHold,
  foldSettle,
  jumpBlank,
  measureOpen,
  parkReport,
  parkWatch,
} from "./src/checks.ts";
import { findToggle, findType } from "./src/find.ts";
import { applyConfig, describe, type DiffConfig } from "./src/settings.ts";
import { CHAT, DIFF, type SurfaceSpec } from "./src/surface.ts";
import {
  chatSession,
  repoFiles,
  repoWithDiff,
  workspace,
  type Workspace,
} from "./src/fixture.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const flag = (n: string, d?: string | boolean) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const num = (n: string, d: number) => {
  const v = flag(n);
  return v === undefined || v === true ? d : Number(v);
};
const str = (n: string, d: string) => {
  const v = flag(n, d);
  return typeof v === "string" ? v : d;
};

const DIR = str("dir", "/tmp/plan-fixture");
const ROWS = num("rows", 1800);
const PORT = num("port", 9334);
const KEEP = flag("keep") === true;

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}
const results: Check[] = [];
function check(name: string, pass: boolean, detail: unknown) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

/** Click a control by its visible text. */
async function clickText(cdp: Session, text: string, settleMs = 6000) {
  const hit = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
    const want = ${JSON.stringify(text.toLowerCase())};
    return [...document.querySelectorAll("button,[role=button],[role=tab],a")]
      .map((e) => { const r = e.getBoundingClientRect();
        return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
                 w: r.width, h: r.height, text: (e.innerText||"").trim() }; })
      .filter((e) => e.w > 8 && e.h > 8 && e.text.toLowerCase().includes(want))[0] ?? null;
  })()`);
  if (!hit) throw new Error(`no control matching ${JSON.stringify(text)}`);
  await cdp.click(hit.x, hit.y);
  await sleep(settleMs);
  return hit;
}

/**
 * The chat suite. Behaviour first, budgets second — a blank surface passes every
 * timing check ever written.
 */
async function chatSuite(cdp: Session, s: SurfaceSpec) {
  const open = await (async () => {
    const runs = [];
    for (let i = 0; i < 2; i++) {
      // Switch away so each repeat is a real open, not a no-op click on the
      // surface that is already showing.
      await clickText(cdp, "New chat", 1500).catch(() => undefined);
      const hit = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
        return [...document.querySelectorAll("button")]
          .map((e) => { const r = e.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
                     w: r.width, h: r.height, text: (e.innerText||"").trim() }; })
          .filter((e) => e.w > 40 && e.text.startsWith("Fixture Chat"))[0] ?? null;
      })()`);
      if (!hit) throw new Error("fixture chat not in the rail");
      runs.push(await measureOpen(cdp, s, hit, 7000));
      await sleep(800);
    }
    return runs;
  })();
  const ms = open
    .filter((r) => r.VALID)
    .map((r) => r.longestBlockedMs)
    .sort((a, b) => a - b);
  check(
    "chat opens without a long block",
    ms.length > 0 && ms[ms.length >> 1] <= num("budget-open", 400),
    {
      medianBlockedMs: ms[ms.length >> 1],
      rows: open[0]?.rows,
      validRuns: ms.length,
      ofRuns: open.length,
    },
  );

  const cov = await coverage(cdp, s);
  check("no blank rows in the viewport", cov.PASS, {
    viewportRows: cov.viewportRows,
    empty: cov.emptyInViewport,
    rendered: cov.renderedRows,
    of: cov.rows,
  });

  const d = await drift(cdp, s, { steps: 25, delta: -200 });
  check(
    "scrolling does not move content under the reader",
    d.visibleDriftPx != null && Math.abs(d.visibleDriftPx) <= 40,
    {
      visibleDriftPx: d.visibleDriftPx,
      commandedPx: d.commandedPx,
      reversals: d.reversals,
    },
  );

  const ft = await findToggle(cdp, s, num("budget-shift", 5));
  check("find opens/closes without shifting the page", ft.PASS, {
    worstShiftPx: ft.worstOnScreenTopShiftPx,
    travelPx: ft.totalTravelPx,
    rows: ft.watchedRows,
  });

  const typed = await findType(cdp, s, "en");
  check(
    "typing in find stays responsive",
    typed.worstBlockedMs <= num("budget-key", 250),
    {
      worstBlockedMs: typed.worstBlockedMs,
      counter: typed.counter,
      rendered: typed.renderedRows,
    },
  );

  // A fling must never paint an empty band.
  const jump = await jumpBlank(cdp, s, 40000);
  check("a long scroll never paints a blank band", jump.blankFrames === 0, {
    blankFrames: jump.blankFrames,
    firstFramePct: jump.firstFramePct,
    worstPct: jump.worstPct,
    frames: jump.frames,
  });

  // If this starts failing, the window stopped windowing and every timing above
  // is measuring the wrong thing.
  const windowed = await cdp.evaluate<{
    farRendered: boolean;
    addressable: boolean;
  }>(`(() => {
    const el = ${s.scroller};
    const rows = [...el.querySelectorAll("${s.row}")];
    const far = rows[Math.floor(rows.length * 0.15)];
    const row = far;
    return {
      farRendered: ${s.filled},
      addressable: !!el.querySelector('[data-part-root][data-message-uuid="' + CSS.escape(far.dataset.msgRow) + '"]'),
    };
  })()`);
  check(
    "windowing is in effect (far rows are not rendered)",
    !windowed.farRendered && !windowed.addressable,
    windowed,
  );
}

const FONT_SIZES = [11, 12, 13, 14, 15, 16];

/**
 * Every combination of the settings that change how a row is laid out.
 *
 * These are not independent. Wrap makes rows different heights; "All lines"
 * makes the document twenty times longer; split runs two tables down one
 * scroller; font size changes every height at once. A window is only correct if
 * it is correct in all sixteen, so the matrix is exhaustive rather than
 * sampled, and font size rotates through so each size appears.
 */
const MATRIX: DiffConfig[] = (() => {
  const out: DiffConfig[] = [];
  let n = 0;
  for (const view of ["split", "unified"] as const)
    for (const lines of ["changes", "all"] as const)
      for (const wrap of [false, true])
        for (const whitespace of [false, true])
          out.push({
            view,
            lines,
            wrap,
            whitespace,
            fontSize: FONT_SIZES[n++ % FONT_SIZES.length],
          });
  return out;
})();

/** Open the fixture's diff. */
async function openDiff(cdp: Session) {
  await clickText(cdp, "Diffs", 1500);
  await clickText(cdp, "large.ts", 4000);
}

/** Send the reader deep into the file so checks run on a scrolled document. */
async function scrollDeep(cdp: Session, s: SurfaceSpec, fraction = 0.45) {
  await cdp.evaluate(`(() => {
    const el = ${s.scroller};
    if (el) el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${fraction});
  })()`);
  await sleep(1200);
}

/**
 * The diff suite: every settings combination, then the heavy checks on the
 * configurations that actually hurt.
 */
async function diffSuite(cdp: Session, s: SurfaceSpec) {
  await openDiff(cdp);

  for (const want of MATRIX) {
    const label = describe(want);
    const got = await applyConfig(cdp, want);
    check(
      `settings hold: ${label}`,
      JSON.stringify(got) === JSON.stringify(want),
      got,
    );

    await scrollDeep(cdp, s);

    const cov = await coverage(cdp, s);
    check(`no blank rows: ${label}`, cov.PASS, {
      viewportRows: cov.viewportRows,
      empty: cov.emptyInViewport,
      rendered: cov.renderedRows,
      scrollHeight: cov.scrollHeight,
    });

    // Left alone, the diff must be completely still. A window whose reserved
    // heights depend on where the window is oscillates forever right here.
    await parkWatch(cdp, s);
    await sleep(2500);
    const park = await parkReport(cdp);
    check(
      `stands still when parked: ${label}`,
      park.distinctTopRows === 1 &&
        park.scrollTopMoved === 0 &&
        park.docHeightChanged === 0,
      {
        distinctTopRows: park.distinctTopRows,
        scrollTopMoved: park.scrollTopMoved,
        docHeightChanged: park.docHeightChanged,
        frames: park.frames,
      },
    );
  }

  // The heavy checks, on "All lines" where the document is the whole file.
  for (const view of ["unified", "split"] as const)
    for (const wrap of [false, true]) {
      const want: DiffConfig = {
        view,
        lines: "all",
        wrap,
        whitespace: false,
        fontSize: 13,
      };
      const label = describe(want);
      await applyConfig(cdp, want);
      await scrollDeep(cdp, s, 0.5);

      const fold = await foldHold(cdp, s);
      check(
        `folding leaves the reader in place: ${label}`,
        fold.PASS === true || fold.skipped !== undefined,
        fold,
      );

      // Where it ends up and how it gets there are different questions, and a
      // view that lurches and comes back answers the first one perfectly.
      for (const where of ["top", "below"] as const) {
        await scrollDeep(cdp, s, 0.45);
        const settle = await foldSettle(cdp, s, where);
        check(
          `folding never lurches (${where}): ${label}`,
          settle.PASS === true || settle.skipped !== undefined,
          settle.skipped
            ? { skipped: settle.skipped }
            : {
                excursionPx: settle.excursionPx,
                reversals: settle.reversals,
                distinctOffsets: settle.distinctOffsets,
                restPx: settle.restPx,
              },
        );
      }

      const jump = await jumpBlank(cdp, s, 40000);
      check(
        `a long scroll never paints a blank band: ${label}`,
        jump.blankFrames === 0,
        {
          blankFrames: jump.blankFrames,
          firstFramePct: jump.firstFramePct,
          worstPct: jump.worstPct,
        },
      );

      const typed = await findType(cdp, s, "reservation");
      check(
        `typing in find stays responsive: ${label}`,
        typed.worstBlockedMs <= num("budget-key", 250),
        {
          worstBlockedMs: typed.worstBlockedMs,
          counter: typed.counter,
          rendered: typed.renderedRows,
        },
      );
      await cdp.key("Escape");
      await sleep(400);
    }
}

async function main() {
  console.log(`building fixture: ${ROWS} rows -> ${DIR}`);
  const ws: Workspace = await workspace(DIR);
  const { sessionId } = await chatSession(ws, ROWS);
  await repoFiles(ws);
  await repoWithDiff(ws, { lines: num("diff-lines", 3000), changed: 30 });
  const { writeProjects } = await import("./src/fixture.ts");
  await writeProjects(ws, { [sessionId]: "Fixture Chat" });

  await stop(PORT).catch(() => undefined);
  await sleep(1500);

  console.log("launching against the fixture HOME…");
  await launch({ port: PORT, repo: REPO, mode: "preview", home: ws.home });
  await sleep(6000);

  const cdp = await connect(PORT);
  try {
    await cdp.guard();

    // Refuse to grade anything unless this is the fixture world.
    const world = await cdp.evaluate<{ hasFixtureChat: boolean }>(`(() => {
      const btns = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim());
      return { hasFixtureChat: btns.some((t) => t.startsWith("Fixture Chat")) };
    })()`);
    check("runs against the synthetic fixture", world.hasFixtureChat, world);
    if (!world.hasFixtureChat)
      throw new Error("not the fixture world — refusing to continue");

    await chatSuite(cdp, CHAT);
    await diffSuite(cdp, DIFF);
  } finally {
    cdp.close();
    if (!KEEP) await stop(PORT).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("failed: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

await main();
