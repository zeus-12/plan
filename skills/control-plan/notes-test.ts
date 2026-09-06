#!/usr/bin/env -S npx tsx
/**
 * End-to-end behaviour run for the per-chat Notes stash.
 *
 *   pnpm -C skills/control-plan exec tsx notes-test.ts
 *   pnpm -C skills/control-plan exec tsx notes-test.ts --keep
 *
 * Correctness only — no budgets — so it runs against the dev build. Like
 * `test.ts` it builds its own HOME, so it never touches real notes.
 *
 * The two checks that matter:
 *   - a stash that cannot be READ is never overwritten by an edit
 *   - ⇧⇧ captures the selection, including while the transcript is updating
 */

import { execFile } from "node:child_process";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep, MOD, type Session } from "./src/cdp.ts";
import { launch, stop } from "./src/app.ts";
import {
  chatSession,
  repoFiles,
  repoWithDiff,
  workspace,
  writeProjects,
  FIXTURE_SESSION_ID,
  type Workspace,
} from "./src/fixture.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const PORT = 9336;
const ATTACH = flag("attach");
const DIR = "/tmp/plan-notes-fixture";

/** Kill anything still holding THIS run's debugging port. Scoped to the flag so
 *  it can never touch another Electron app. */
const sweep = () =>
  new Promise<void>((r) => {
    execFile("pkill", ["-f", `remote-debugging-port=${PORT}`], () => r());
  });

let failures = 0;
function check(name: string, pass: boolean, detail: unknown = "") {
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : "  " + JSON.stringify(detail)}`,
  );
}

const notesFile = (ws: Workspace) =>
  join(ws.home, ".plan", "notes", `${ws.encoded}.json`);

async function readStash(ws: Workspace): Promise<any> {
  try {
    return JSON.parse(await readFile(notesFile(ws), "utf8"));
  } catch (e: any) {
    return { error: e.code ?? String(e) };
  }
}

/** Poll until `text` names a visible control, so a slow cold start can't be
 *  mistaken for the wrong world. */
async function waitForText(cdp: Session, text: string, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = await cdp.evaluate<boolean>(`(() => {
      const want = ${JSON.stringify(text.toLowerCase())};
      return [...document.querySelectorAll("button,[role=button],[role=tab]")]
        .some((e) => (e.innerText || "").toLowerCase().includes(want));
    })()`);
    if (seen) return true;
    await sleep(500);
  }
  return false;
}

/** Click a control by visible text. */
async function clickText(cdp: Session, text: string, settleMs = 700) {
  const hit = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
    const want = ${JSON.stringify(text.toLowerCase())};
    return [...document.querySelectorAll("button,[role=button],[role=tab]")]
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

/** The note card texts currently on screen, in list order. */
const cardTexts = (cdp: Session) =>
  cdp.evaluate<string[]>(
    `[...document.querySelectorAll("[data-note-card]")].map((e) =>
       (e.querySelector("[data-note-text]")?.textContent ?? "").trim())`,
  );

const panelText = (cdp: Session) =>
  cdp.evaluate<string>(
    `(document.querySelector("[data-notes-panel]")?.innerText ?? "").trim()`,
  );

/** Two Shift presses inside the double-tap window, with `between` in the gap. */
async function doubleShift(cdp: Session, between?: () => Promise<void>) {
  const K = { key: "Shift", code: "ShiftLeft", vk: 16 };
  const t0 = Date.now();
  await cdp.keyEvent("rawKeyDown", K, MOD.shift);
  await cdp.keyEvent("keyUp", K, 0);
  if (between) await between();
  else await sleep(60);
  // The real gesture: how far apart the two presses actually were. Must stay
  // inside the app's double-tap window for the check to mean anything.
  const gapMs = Date.now() - t0;
  await cdp.keyEvent("rawKeyDown", K, MOD.shift);
  await cdp.keyEvent("keyUp", K, 0);
  await sleep(600);
  return gapMs;
}

/**
 * Put the document selection over the first N chars of a rendered transcript
 * paragraph. Rows are windowed, so most `[data-msg-row]` elements are empty
 * placeholders — pick one that actually painted text.
 */
const selectInTranscript = (cdp: Session, chars: number) =>
  cdp.evaluate<string>(`(() => {
    const p = [...document.querySelectorAll("[data-msg-row] p")]
      .find((e) => (e.textContent || "").trim().length >= 40 &&
                   e.getBoundingClientRect().height > 0);
    if (!p) return "";
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node && node.textContent.trim().length < 40) node = walk.nextNode();
    if (!node) return "";
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, Math.min(${chars}, node.textContent.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString();
  })()`);

/** Drop every selection the harness can hold — the document one AND any that
 *  lives on a focused input, which ⇧⇧ reads separately. */
const clearSelection = (cdp: Session) =>
  cdp.evaluate(`(() => {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      el.setSelectionRange(el.value.length, el.value.length);
      el.blur();
    }
    getSelection().removeAllRanges();
  })()`);

async function main() {
  const ws: Workspace = {
    dir: DIR,
    home: join(DIR, "home"),
    cwd: join(DIR, "repo"),
    encoded: join(DIR, "repo").replace(/[^a-zA-Z0-9]/g, "-"),
  };
  if (!ATTACH) {
    Object.assign(ws, await workspace(DIR));
    await chatSession(ws, 120, { sessionId: FIXTURE_SESSION_ID });
    await repoFiles(ws);
    await repoWithDiff(ws, { lines: 200, changed: 4 });
    await writeProjects(ws, { [FIXTURE_SESSION_ID]: "Fixture Chat A" });
    await stop(PORT).catch(() => undefined);
    await sweep();
    await sleep(1000);

    console.log("launching…");
    // preview, not dev: the wipe-proofing lives in the MAIN process, and only a
    // real build exercises the main bundle a user actually runs.
    await launch({
      port: PORT,
      repo: REPO,
      mode: "preview",
      build: true,
      home: ws.home,
    });
  } else {
    // Iterating against an instance left up by --keep: reset only the stash.
    await rm(notesFile(ws), { force: true }).catch(() => undefined);
  }

  // CDP answers before the BrowserWindow has a page; retry until it does.
  let cdp: Session | null = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    cdp = await connect(PORT).catch(() => null);
    if (!cdp) await sleep(1000);
  }
  if (!cdp) throw new Error("no Plan window appeared on CDP");
  const g = await cdp.guard();
  // Refuse to grade a renderer served by some other checkout's dev server.
  if (!ATTACH && g.build !== "preview") {
    throw new Error(
      `expected the built renderer, got ${g.build} — is ELECTRON_RENDERER_URL set?`,
    );
  }
  if (ATTACH) {
    await cdp.send("Page.reload", {});
    await sleep(3000);
  }
  if (!(await waitForText(cdp, "Fixture Chat A"))) {
    throw new Error("fixture workspace never rendered — wrong world?");
  }

  try {
    const world = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll("button")].map((b) => (b.innerText||"").trim()).filter(Boolean).slice(0, 40)`,
    );
    check(
      "runs against the synthetic fixture",
      world.some((t) => t.startsWith("Fixture Chat")),
      world,
    );

    // ── open the fixture chat, then the Notes pane ──────────────────────
    await clickText(cdp, "Fixture Chat A", 2500);
    await clickText(cdp, "Notes", 800);
    check(
      "Notes pane opens with an empty stash",
      (await panelText(cdp)).includes("Nothing stashed yet"),
      (await panelText(cdp)).slice(0, 60),
    );

    // ── add one from the composer ───────────────────────────────────────
    // Click it for real (that is the flow under test), but confirm the caret
    // landed before typing — a click on a rect measured mid-layout silently
    // types into nothing.
    let focused = false;
    for (let i = 0; i < 5 && !focused; i++) {
      const box = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const t = document.querySelector("[data-notes-composer]");
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await cdp.click(box.x, box.y);
      await sleep(300);
      focused = await cdp.evaluate<boolean>(
        `!!document.activeElement?.hasAttribute?.("data-notes-composer")`,
      );
    }
    check(
      "clicking the composer lands the caret",
      focused,
      focused
        ? ""
        : await cdp.evaluate<string>(
            `(document.activeElement?.tagName ?? "none") + " " +
             (document.activeElement?.className ?? "").slice(0, 40)`,
          ),
    );
    await cdp.type("typed note");
    await sleep(200);
    const draft = await cdp.evaluate<string>(
      `document.querySelector("[data-notes-composer]").value`,
    );
    check("typing reaches the composer", draft === "typed note", draft);
    await cdp.key("Enter");
    await sleep(600);
    check(
      "composer adds a note",
      (await cardTexts(cdp)).includes("typed note"),
      await cardTexts(cdp),
    );
    check(
      "the note reached disk",
      JSON.stringify(await readStash(ws)).includes("typed note"),
    );

    // ── ⇧⇧ from a transcript selection ──────────────────────────────────
    await clearSelection(cdp);
    const picked = await selectInTranscript(cdp, 24);
    check(
      "the harness selected real transcript text",
      picked.trim().length > 10,
      picked,
    );
    await doubleShift(cdp);
    let texts = await cardTexts(cdp);
    check(
      "⇧⇧ stashes the transcript selection",
      texts.includes(picked.trim()),
      {
        picked: picked.trim(),
        texts,
      },
    );
    const sourced = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll("[data-note-source]")].map((e) => e.textContent)`,
    );
    check(
      "the capture records where it came from",
      sourced.length > 0,
      sourced,
    );

    // ── ⇧⇧ from a <textarea> selection (Chromium reports no doc selection) ──
    await cdp.evaluate(`(() => {
      const t = document.querySelector("[data-notes-composer]");
      t.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(t, "from the textarea");
      t.dispatchEvent(new Event("input", { bubbles: true }));
      t.setSelectionRange(5, 17);
    })()`);
    await sleep(200);
    await doubleShift(cdp);
    texts = await cardTexts(cdp);
    check(
      "⇧⇧ stashes a textarea selection",
      texts.includes("the textarea"),
      texts,
    );

    // NOTE: the deps regression this feature also fixed — the capture effect
    // used to re-register on every transcript tick, resetting the double-tap
    // timer — is NOT covered here. Provoking it needs a re-render to land
    // between the two Shift presses, and every watcher in this app is debounced
    // longer than the 400ms double-tap window, so it cannot be forced from out
    // here. The checks above cover the gesture itself; the deps change is
    // verified by reading it.

    // ── the stash follows the chat, not the centre pane ──────────────────
    // Regression: notes were keyed on the ACTIVE TAB's chat, so opening a diff
    // emptied the pane and made ⇧⇧ a no-op — exactly when you most want to jot
    // something down. They must stay bound to the chat you were last in.
    const stashed = await cardTexts(cdp);
    await clickText(cdp, "Diffs", 1500);
    await clickText(cdp, "large.ts", 3000);
    check(
      "the stash survives opening a diff tab",
      JSON.stringify(await cardTexts(cdp)) === JSON.stringify(stashed),
      { onDiff: (await cardTexts(cdp)).length, expected: stashed.length },
    );

    const fromDiff = await cdp.evaluate<string>(`(() => {
      const host = document.querySelector("[data-tight-selection]")
        ?? document.querySelector(".content-card");
      const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node = walk.nextNode();
      while (node && (node.textContent.trim().length < 20 ||
                      !node.parentElement?.getBoundingClientRect().height))
        node = walk.nextNode();
      if (!node) return "";
      const r = document.createRange();
      r.setStart(node, 0); r.setEnd(node, 20);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return s.toString();
    })()`);
    await doubleShift(cdp);
    const afterDiff = await cardTexts(cdp);
    check(
      "⇧⇧ captures from a diff tab",
      fromDiff.trim().length > 5 &&
        afterDiff.length === stashed.length + 1 &&
        afterDiff.includes(fromDiff.trim()),
      {
        picked: fromDiff.trim(),
        before: stashed.length,
        after: afterDiff.length,
      },
    );
    await clickText(cdp, "Chat", 800);
    await clickText(cdp, "Fixture Chat A", 2000);

    // ── ⇧⇧ with no selection opens the stash instead ─────────────────────
    await clickText(cdp, "Run", 500);
    await clearSelection(cdp);
    await doubleShift(cdp);
    check(
      "⇧⇧ with nothing selected reveals the Notes pane",
      await cdp.evaluate<boolean>(
        `(() => { const p = document.querySelector("[data-notes-panel]");
                  return !!p && p.offsetParent !== null; })()`,
      ),
    );

    // ── copy as list ─────────────────────────────────────────────────────
    await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll("[data-note-card]")];
      cards[0].click();
      cards[1].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    })()`);
    await sleep(300);
    const listed = await cdp.evaluate<string>(`(async () => {
      const btn = [...document.querySelectorAll("button")]
        .find((b) => (b.getAttribute("aria-label") || "").startsWith("Copy as list"));
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return await navigator.clipboard.readText();
    })()`);
    check(
      "Copy as list writes a numbered list to the clipboard",
      /^1\. .+\n2\. /.test(listed),
      listed.slice(0, 80),
    );

    // ── notes survive a renderer reload ──────────────────────────────────
    const beforeReload = await cardTexts(cdp);
    await cdp.send("Page.reload", {});
    await sleep(6000);
    await clickText(cdp, "Fixture Chat A", 2500).catch(() => undefined);
    await clickText(cdp, "Notes", 800);
    check(
      "notes survive a renderer reload",
      JSON.stringify(await cardTexts(cdp)) === JSON.stringify(beforeReload),
      { before: beforeReload.length, after: (await cardTexts(cdp)).length },
    );

    // ── THE BIG ONE: an unreadable stash is never overwritten ────────────
    const onDisk = await readFile(notesFile(ws), "utf8");
    const sizeBefore = (await stat(notesFile(ws))).size;
    await chmod(notesFile(ws), 0o000);
    await cdp.send("Page.reload", {});
    await sleep(6000);
    await clickText(cdp, "Fixture Chat A", 2500).catch(() => undefined);
    await clickText(cdp, "Notes", 1000);
    const locked = await panelText(cdp);
    check(
      "an unreadable stash shows as locked, not empty",
      locked.includes("locked") && !locked.includes("Nothing stashed yet"),
      locked.slice(0, 90),
    );

    // Try to edit anyway — through the composer AND through ⇧⇧.
    await cdp
      .evaluate(
        `(() => { const t = document.querySelector("[data-notes-composer]"); if (!t) return; t.focus(); })()`,
      )
      .catch(() => undefined);
    await cdp.type("this must not be written");
    await cdp.key("Enter");
    await selectInTranscript(cdp, 20).catch(() => undefined);
    await doubleShift(cdp);
    await sleep(800);
    await chmod(notesFile(ws), 0o600);
    const after = await readFile(notesFile(ws), "utf8");
    check(
      "the unreadable stash on disk is byte-identical after edit attempts",
      after === onDisk,
      { sizeBefore, sizeAfter: (await stat(notesFile(ws))).size },
    );

    // ── Retry brings it back ─────────────────────────────────────────────
    await clickText(cdp, "Retry", 1200);
    check(
      "Retry reloads the stash once the file is readable again",
      (await cardTexts(cdp)).length === beforeReload.length,
      { cards: (await cardTexts(cdp)).length, expected: beforeReload.length },
    );
  } finally {
    cdp.close();
    if (!flag("keep") && !ATTACH) {
      await stop(PORT).catch(() => undefined);
      // `stop` kills the process group it recorded, but the Electron child has
      // been seen to outlive it and keep the port — which then wedges the next
      // run's CDP fetch. Sweep by the debugging port, which only this run uses.
      await sweep();
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  if (!flag("keep") && !ATTACH) {
    await stop(PORT).catch(() => undefined);
    await sweep();
  }
  process.exit(1);
});
