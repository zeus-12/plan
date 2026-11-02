#!/usr/bin/env -S npx tsx
/**
 * End-to-end behaviour run for the project + worktree switcher.
 *
 *   pnpm -C skills/control-plan exec tsx switcher-test.ts
 *
 * CDP input passes through main's before-input-event, so this covers the whole
 * path inside the app. It cannot see a key macOS eats before the app does: when
 * this passes and the real key does nothing, the OS is the suspect.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, MOD, type Session } from "./src/cdp.ts";
import { launch, stop } from "./src/app.ts";
import { encodeCwd, workspace } from "./src/fixture.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 9337;

const CTRL = { key: "Control", code: "ControlLeft", vk: 17 };
const META = { key: "Meta", code: "MetaLeft", vk: 91 };
const SHIFT = { key: "Shift", code: "ShiftLeft", vk: 16 };
const BACKQUOTE = { key: "`", code: "Backquote", vk: 192 };
const DIGIT1 = { key: "1", code: "Digit1", vk: 49 };

let failures = 0;
function check(name: string, pass: boolean, detail: unknown = "") {
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : "  " + JSON.stringify(detail)}`,
  );
}

const overlayOpen = (cdp: Session) =>
  cdp.evaluate<boolean>(
    `[...document.querySelectorAll("div")].some((d) => d.children.length === 0 && d.textContent === "Switch to")`,
  );

const currentProject = (cdp: Session, cwds: string[]) =>
  cdp.evaluate<string | null>(`(() => {
    const cwds = ${JSON.stringify(cwds)};
    const hit = [...document.querySelectorAll("span, div")].find(
      (e) => e.children.length === 0 && cwds.includes(e.textContent.trim()) && e.checkVisibility(),
    );
    return hit ? hit.textContent.trim() : null;
  })()`);

type Key = typeof BACKQUOTE;

/** Hold Ctrl, tap the trigger `taps` times, report the overlay, then release. */
async function gesture(cdp: Session, trigger: Key, taps = 1, back = false) {
  const mods = MOD.ctrl | (back ? MOD.shift : 0);
  await cdp.keyEvent("rawKeyDown", CTRL, MOD.ctrl);
  if (back) await cdp.keyEvent("rawKeyDown", SHIFT, mods);
  await sleep(60);
  for (let i = 0; i < taps; i++) {
    await cdp.keyEvent("rawKeyDown", trigger, mods);
    await cdp.keyEvent("keyUp", trigger, mods);
    await sleep(120);
  }
  const openWhileHeld = await overlayOpen(cdp);
  await cdp.keyEvent("keyUp", CTRL, back ? MOD.shift : 0);
  if (back) await cdp.keyEvent("keyUp", SHIFT, 0);
  await sleep(600);
  return { openWhileHeld, openAfterRelease: await overlayOpen(cdp) };
}

async function main() {
  const ws = await workspace(join(tmpdir(), "plan-switcher-fixture"));
  const cwds = ["alpha", "beta", "gamma"].map((n) => join(ws.dir, n));
  for (const cwd of cwds) {
    await mkdir(cwd, { recursive: true });
    await mkdir(join(ws.home, ".claude", "projects", encodeCwd(cwd)), {
      recursive: true,
    });
  }
  await writeFile(
    join(ws.home, ".plan", "projects.json"),
    JSON.stringify({
      manualCwds: cwds,
      archivedEncoded: [],
      archivedSessions: [],
      sessionNames: {},
    }),
  );

  await launch({ port: PORT, repo: REPO, mode: "dev", home: ws.home });
  // CDP answers before the page has its title, and connect refuses until then.
  let cdp: Session | undefined;
  for (let i = 0; i < 60 && !cdp; i++) {
    await sleep(500);
    cdp = await connect(PORT).catch(() => undefined);
  }
  if (!cdp) throw new Error(`no Plan window on ${PORT} after 30s`);
  const session = cdp;
  try {
    let start: string | null = null;
    for (let i = 0; i < 60 && !start; i++) {
      await sleep(500);
      start = await currentProject(session, cwds);
    }
    check("the app opens on a project", start !== null, { start });
    const current = () => currentProject(session, cwds);

    for (const [name, trigger] of [
      ["Ctrl+`", BACKQUOTE],
      ["Ctrl+1", DIGIT1],
    ] as const) {
      const before = await current();
      const g = await gesture(session, trigger);
      const after = await current();
      check(`${name} opens the switcher while Ctrl is held`, g.openWhileHeld);
      check(`${name} closes it on release`, !g.openAfterRelease);
      check(`${name} lands on another project`, after !== before, {
        before,
        after,
      });
    }

    // Recency order is [current, previous, third], so one step back wraps to
    // the third and two steps forward reach it too.
    const a = await current();
    await gesture(session, BACKQUOTE);
    const b = await current();
    await gesture(session, BACKQUOTE);
    check(
      "one Ctrl+` returns to the previous project",
      (await current()) === a,
    );
    await gesture(session, BACKQUOTE, 1, true);
    const c = await current();
    check(
      "Ctrl+Shift+` steps backward to the third project",
      c !== a && c !== b,
      { a, b, c },
    );
    await gesture(session, BACKQUOTE);
    const previous = await current();
    await gesture(session, BACKQUOTE);
    await gesture(session, BACKQUOTE, 2);
    const third = await current();
    check(
      "tapping ` twice under one Ctrl hold moves two steps",
      third !== previous && third !== c,
      { previous, c, third },
    );

    const beforePlain = await current();
    await session.keyEvent("rawKeyDown", BACKQUOTE, 0);
    await session.keyEvent("keyUp", BACKQUOTE, 0);
    await sleep(200);
    check("a plain ` opens nothing", !(await overlayOpen(session)));

    await session.keyEvent("rawKeyDown", META, MOD.meta);
    await session.keyEvent("rawKeyDown", BACKQUOTE, MOD.meta);
    await session.keyEvent("keyUp", BACKQUOTE, MOD.meta);
    await sleep(200);
    const cmdOpen = await overlayOpen(session);
    await session.keyEvent("keyUp", META, 0);
    await sleep(300);
    check("Cmd+` stays with macOS and opens nothing", !cmdOpen);
    check("neither key changed the project", (await current()) === beforePlain);
  } finally {
    session.close();
    await stop(PORT).catch(() => undefined);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await stop(PORT).catch(() => undefined);
  process.exit(1);
});
