#!/usr/bin/env -S npx tsx
/**
 * control-plan — drive and measure the Plan desktop app over CDP.
 *
 *   pnpm -C skills/control-plan cli <command> [flags]
 *
 * Layers, so a second surface costs almost nothing:
 *   src/cdp.ts      transport, guard, synthetic input       (app-agnostic)
 *   src/app.ts      launch / stop / doctor                  (app lifecycle)
 *   src/surface.ts  what a measurable surface IS            (chat, diff, …)
 *   src/checks.ts   open cost, coverage, drift              (per surface)
 *   src/find.ts     find toggle + typing cost               (per surface)
 *   src/fixture.ts  synthetic worlds                        (shared + per surface)
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { connect, GuardFailure, sleep, type Session } from "./src/cdp.ts";
import { doctor, launch, stop } from "./src/app.ts";
import { coverage, drift, measureOpen } from "./src/checks.ts";
import { findToggle, findType } from "./src/find.ts";
import { CHAT, surfaceByName, type SurfaceSpec } from "./src/surface.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This file ships inside the repo it drives: skills/control-plan → root. */
export const REPO_ROOT = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "help";
const flag = (name: string, fallback?: string | boolean) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const num = (name: string, fallback: number): number => {
  const v = flag(name);
  return v === undefined || v === true ? fallback : Number(v);
};
const str = (name: string, fallback: string): string => {
  const v = flag(name, fallback);
  return typeof v === "string" ? v : fallback;
};

const PORT = num("port", 9333);
const REPO = str("repo", REPO_ROOT);
const SURFACE: SurfaceSpec = surfaceByName(str("surface", CHAT.name));

const out = (o: unknown) =>
  console.log(JSON.stringify(o, null, flag("json") === true ? 0 : 1));

async function withSession<T>(
  fn: (cdp: Session) => Promise<T>,
  { guarded = true }: { guarded?: boolean } = {},
): Promise<T> {
  const cdp = await connect(PORT);
  try {
    if (guarded) await cdp.guard();
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

/** Resolve --x/--y, or --match against visible control text. */
async function target(
  cdp: Session,
): Promise<{ x: number; y: number; via: string }> {
  const x = num("x", NaN);
  const y = num("y", NaN);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, via: "coords" };
  const match = flag("match");
  if (!match || match === true)
    throw new Error("need --x/--y or --match <text>");
  const hit = await cdp.evaluate<{
    x: number;
    y: number;
    text: string;
  } | null>(`(() => {
    const want = ${JSON.stringify(String(match).toLowerCase())};
    return [...document.querySelectorAll("button,[role=button],[role=tab],a")]
      .map((e) => { const r = e.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                 w: r.width, h: r.height,
                 text: (e.innerText || "").trim().replace(/\\s+/g, " ") }; })
      .filter((e) => e.w > 8 && e.h > 8 && e.text.toLowerCase().includes(want))[0] ?? null;
  })()`);
  if (!hit)
    throw new Error(`no visible control matching ${JSON.stringify(match)}`);
  return { x: hit.x, y: hit.y, via: hit.text };
}

const commands: Record<string, () => Promise<void>> = {
  async help() {
    console.log(HELP);
  },

  async launch() {
    const mode = str("mode", "preview") as "dev" | "preview";
    const home = flag("home");
    out(
      await launch({
        port: PORT,
        repo: REPO,
        mode,
        build: flag("build") === true,
        home: typeof home === "string" ? home : undefined,
      }),
    );
    process.exit(0); // the child's pipes would keep this alive
  },

  async stop() {
    out(await stop(PORT));
  },

  async doctor() {
    out(await doctor(PORT));
  },

  async eval() {
    const expr = flag("expr");
    if (typeof expr !== "string") throw new Error('usage: eval --expr "<js>"');
    out(
      await withSession((cdp) => cdp.evaluate(`(async () => (${expr}))()`), {
        guarded: false,
      }),
    );
  },

  async buttons() {
    const match = String(flag("match", "") || "").toLowerCase();
    out(
      await withSession(
        (cdp) =>
          cdp.evaluate(`[...document.querySelectorAll("button,[role=button],[role=tab],a")]
            .map((e) => { const r = e.getBoundingClientRect();
              return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
                       w: Math.round(r.width), h: Math.round(r.height),
                       text: (e.innerText||"").trim().replace(/\\s+/g," ").slice(0,60) }; })
            .filter((e) => e.w > 8 && e.h > 8 && e.text)
            .filter((e) => e.text.toLowerCase().includes(${JSON.stringify(match)}))`),
        { guarded: false },
      ),
    );
  },

  async click() {
    out(
      await withSession(async (cdp) => {
        const t = await target(cdp);
        await cdp.click(t.x, t.y);
        await sleep(num("settle", 400));
        return { clicked: t };
      }),
    );
  },

  async wheel() {
    const steps = num("steps", 10);
    const delta = num("delta", -160);
    out(
      await withSession(async (cdp) => {
        const geom = await cdp.evaluate<{
          x: number;
          y: number;
        } | null>(`(() => {
          const el = ${SURFACE.scroller};
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        })()`);
        if (!geom) throw new Error(`no visible ${SURFACE.name} surface`);
        for (let i = 0; i < steps; i++) {
          await cdp.wheel(geom.x, geom.y, delta);
          await sleep(num("gap", 45));
        }
        return {
          wheel: { steps, delta, commandedPx: steps * Math.abs(delta) },
        };
      }),
    );
  },

  async key() {
    const name = flag("name");
    if (typeof name !== "string")
      throw new Error("usage: key --name f [--meta]");
    out(
      await withSession(async (cdp) => {
        await cdp.key(name, { meta: flag("meta") === true });
        await sleep(num("settle", 400));
        return { key: name };
      }),
    );
  },

  async type() {
    const text = flag("text");
    if (typeof text !== "string") throw new Error('usage: type --text "hello"');
    out(
      await withSession(async (cdp) => {
        await cdp.type(text);
        await sleep(num("settle", 500));
        return { typed: text };
      }),
    );
  },

  async screenshot() {
    const path = str("out", join(tmpdir(), `plan-${Date.now()}.png`));
    await withSession(async (cdp) => {
      const res = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(path, Buffer.from(res.result.data, "base64"));
    });
    out({ screenshot: path });
  },

  async open() {
    const repeat = num("repeat", 1);
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      runs.push(
        await withSession(async (cdp) => {
          const t = await target(cdp);
          return measureOpen(cdp, SURFACE, t, num("watch", 7000));
        }),
      );
      if (i + 1 < repeat) await sleep(1200);
    }
    const ms = runs
      .filter((r) => r.VALID)
      .map((r) => r.longestBlockedMs)
      .sort((a, b) => a - b);
    out({
      surface: SURFACE.name,
      runs,
      medianBlockedMs: ms.length ? ms[ms.length >> 1] : null,
    });
  },

  async coverage() {
    const r = await withSession((cdp) => coverage(cdp, SURFACE));
    out({ surface: SURFACE.name, ...r });
    if (!r.PASS) process.exitCode = 1;
  },

  async drift() {
    out({
      surface: SURFACE.name,
      ...(await withSession((cdp) =>
        drift(cdp, SURFACE, {
          steps: num("steps", 25),
          delta: num("delta", -200),
          gap: num("gap", 45),
        }),
      )),
    });
  },

  async find() {
    const r = await withSession((cdp) =>
      findToggle(cdp, SURFACE, num("tolerance", 5), num("travel", 24)),
    );
    out({ surface: SURFACE.name, ...r });
    if (!r.PASS) process.exitCode = 1;
  },

  async findtype() {
    out({
      surface: SURFACE.name,
      ...(await withSession((cdp) =>
        findType(cdp, SURFACE, str("text", "en"), num("index-wait", 9000)),
      )),
    });
  },

  async trace() {
    out(
      await withSession(async (cdp) => {
        const events: any[] = [];
        cdp.on("Tracing.dataCollected", (p) => events.push(...(p.value ?? [])));
        let done!: () => void;
        const complete = new Promise<void>((r) => (done = r));
        cdp.on("Tracing.tracingComplete", () => done());
        await cdp.send("Tracing.start", {
          transferMode: "ReportEvents",
          traceConfig: {
            includedCategories: [
              "devtools.timeline",
              "disabled-by-default-devtools.timeline",
              "blink",
              "blink.user_timing",
            ],
          },
        });
        if (flag("match") || Number.isFinite(num("x", NaN))) {
          const t = await target(cdp);
          await cdp.click(t.x, t.y);
        }
        await sleep(num("ms", 8000));
        await cdp.send("Tracing.end");
        await complete;

        const totals = new Map<string, number>();
        const worst: any[] = [];
        for (const e of events) {
          if (e.ph !== "X" || typeof e.dur !== "number") continue;
          totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
          if (e.dur > 30_000) {
            worst.push({
              ms: Math.round(e.dur / 1000),
              name: e.name,
              url:
                (e.args?.data?.url ?? "").split("/").slice(-2).join("/") ||
                undefined,
              line: e.args?.data?.lineNumber,
            });
          }
        }
        const keep =
          /RecalcStyle|Layout|Paint|UpdateLayer|Composite|ParseHTML|FunctionCall|TimerFire|EventDispatch|Commit|PrePaint|Accessibility|Style/;
        return {
          traceEvents: events.length,
          longestSingleEvents: worst.sort((a, b) => b.ms - a.ms).slice(0, 12),
          totalsMs: [...totals.entries()]
            .filter(([n]) => keep.test(n))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14)
            .map(([name, ms]) => ({ name, ms: Math.round(ms) })),
        };
      }),
    );
  },

  async profile() {
    out(
      await withSession(async (cdp) => {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", {
          interval: num("interval", 150),
        });
        await cdp.send("Profiler.start");
        if (flag("match") || Number.isFinite(num("x", NaN))) {
          const t = await target(cdp);
          await cdp.click(t.x, t.y);
        }
        await sleep(num("ms", 8000));
        const p = (await cdp.send("Profiler.stop")).result?.profile;
        if (!p) throw new Error("no profile returned");
        const byId = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]));
        const counts = new Map<number, number>();
        for (const id of p.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
        // Aggregate by function: the same function appears at hundreds of
        // call-tree nodes and would otherwise split into hundreds of 1ms rows.
        const byLabel = new Map<string, number>();
        for (const [id, c] of counts) {
          const f = byId.get(id).callFrame;
          const k = `${f.functionName || "(anonymous)"} @ ${(f.url || "").split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
          byLabel.set(k, (byLabel.get(k) ?? 0) + c);
        }
        const durationMs = (p.endTime - p.startTime) / 1000;
        return {
          durationMs: Math.round(durationMs),
          top: [...byLabel.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 18)
            .map(([fn, c]) => ({
              fn,
              selfMs: Math.round((c / p.samples.length) * durationMs),
            })),
        };
      }),
    );
  },

  async throttle() {
    const rate = num("cpu", 1);
    await withSession(
      (cdp) => cdp.send("Emulation.setCPUThrottlingRate", { rate }),
      { guarded: false },
    );
    out({ cpuThrottlingRate: rate });
  },
};

const HELP = `control-plan — drive and measure the Plan desktop app over CDP

  pnpm -C skills/control-plan cli <command> [flags]

LIFECYCLE
  launch [--mode dev|preview] [--build] [--home DIR]
  stop
  doctor                       read-only: visible? rAF live? which build?

DRIVE
  eval --expr "<js>"           run JS in the page, print the value
  buttons [--match text]       visible controls with click coordinates
  click --x N --y N | --match text
  wheel [--steps N --delta N --gap ms]
  key --name f [--meta]        |  type --text "..."
  screenshot [--out path]

MEASURE            (all take --surface chat|diff, default chat)
  open --match text [--repeat N]    blocked frames while a surface opens
  coverage                          every row in view has real content
  drift [--steps N --delta N]       did content travel what the gesture asked?
  find [--tolerance px]             does opening/closing find hold position?
  findtype [--text en]              worst blocked frame from typing in find
  trace [--match text] [--ms N]     style / layout / paint / event dispatch
  profile [--match text] [--ms N]   top JS functions by self time
  throttle --cpu N

DETERMINISTIC RUN
  pnpm -C skills/control-plan test        fixture -> launch -> assert -> tear down

WHY THIS REFUSES THINGS
  A hidden or minimised window suspends requestAnimationFrame, so any per-frame
  harness hangs instead of failing and prints numbers about nothing. It also
  refuses to drive a window that is not Plan, and refuses to kill a process it
  did not start.

FLAGS
  --port N      CDP port (default 9333)
  --repo PATH   repo root (default: the repo this skill lives in)
  --surface S   chat | diff
  --json        single-line JSON
`;

const fn = commands[command];
if (!fn) {
  console.log(HELP);
  process.exit(command === "help" || argv.includes("--help") ? 0 : 2);
}
try {
  await fn();
} catch (err) {
  if (err instanceof GuardFailure) {
    console.error(err.message);
    console.error(
      "Un-minimise the Plan window, or relaunch: control-plan launch",
    );
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}
