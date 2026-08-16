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
import { coverage, drift, measureOpen } from "./src/checks.ts";
import { findToggle, findType } from "./src/find.ts";
import { CHAT, type SurfaceSpec } from "./src/surface.ts";
import {
  chatSession,
  repoFiles,
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

async function main() {
  console.log(`building fixture: ${ROWS} rows -> ${DIR}`);
  const ws: Workspace = await workspace(DIR);
  const { sessionId } = await chatSession(ws, ROWS);
  await repoFiles(ws);
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
