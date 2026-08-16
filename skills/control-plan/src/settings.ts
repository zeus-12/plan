/**
 * The diff's own settings, driven through the gear popover.
 *
 * Every control is clicked the way a person clicks it, and the state each one
 * reports is read back out of the DOM afterwards. Nothing here writes the
 * settings store directly: a run that sets its own state proves the renderer
 * works in a configuration the app can never actually be in.
 *
 * View, lines, wrap and whitespace all mark themselves active with the accent
 * background; font size is a native select.
 */

import { sleep, type Session } from "./cdp.ts";

export interface DiffConfig {
  view: "split" | "unified";
  lines: "changes" | "all";
  wrap: boolean;
  whitespace: boolean;
  fontSize: number;
}

export const DEFAULT_CONFIG: DiffConfig = {
  view: "split",
  lines: "changes",
  wrap: false,
  whitespace: false,
  fontSize: 13,
};

const GEAR = `document.querySelector('button[aria-label="Diff settings"]')`;

/** A control's label → whether it is currently on, and where to click it. */
const CONTROLS = `(() => {
  const out = {};
  for (const b of document.querySelectorAll("button")) {
    const t = (b.textContent || "").trim();
    if (!/^(Split|Unified|Changes only|All lines|Line wrap|Ignore whitespace)$/.test(t)) continue;
    const r = b.getBoundingClientRect();
    if (r.width === 0) continue;
    out[t] = {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      on: b.className.includes("bg-[var(--accent)]"),
    };
  }
  return out;
})()`;

type Control = { x: number; y: number; on: boolean };

async function openPopover(cdp: Session): Promise<void> {
  const open = await cdp.evaluate<boolean>(
    `${GEAR} ? ${GEAR}.getAttribute("aria-expanded") === "true" : false`,
  );
  if (open) return;
  const at = await cdp.evaluate<{ x: number; y: number } | null>(
    `(() => { const g = ${GEAR}; if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`,
  );
  if (!at) throw new Error("no diff settings gear on screen — is a diff open?");
  await cdp.click(at.x, at.y);
  await sleep(120);
}

async function closePopover(cdp: Session): Promise<void> {
  const open = await cdp.evaluate<boolean>(
    `${GEAR} ? ${GEAR}.getAttribute("aria-expanded") === "true" : false`,
  );
  if (!open) return;
  const at = await cdp.evaluate<{ x: number; y: number }>(
    `(() => { const r = ${GEAR}.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`,
  );
  await cdp.click(at.x, at.y);
  await sleep(120);
}

/** Read what the popover says it is set to. Requires the popover open. */
async function read(cdp: Session): Promise<Record<string, Control>> {
  return cdp.evaluate<Record<string, Control>>(CONTROLS);
}

/**
 * Put the diff into `want`. Only the controls that disagree are clicked, so a
 * matrix run costs one click per changed setting rather than a full reset.
 */
export async function applyConfig(
  cdp: Session,
  want: DiffConfig,
): Promise<DiffConfig> {
  await openPopover(cdp);

  // `segmented` options are one-of-N: the off state is reached by turning the
  // sibling on, never by clicking the option itself. The rest are toggles, and
  // clicking is the only way either direction.
  const wanted: { label: string; on: boolean; segmented: boolean }[] = [
    { label: "Split", on: want.view === "split", segmented: true },
    { label: "Unified", on: want.view === "unified", segmented: true },
    { label: "Changes only", on: want.lines === "changes", segmented: true },
    { label: "All lines", on: want.lines === "all", segmented: true },
    { label: "Line wrap", on: want.wrap, segmented: false },
    { label: "Ignore whitespace", on: want.whitespace, segmented: false },
  ];

  for (const { label, on, segmented } of wanted) {
    const controls = await read(cdp);
    const c = controls[label];
    // Split/Unified disappear on a first version, where there is no old side.
    if (!c || c.on === on) continue;
    if (segmented && !on) continue;
    await cdp.click(c.x, c.y);
    await sleep(160);
  }

  await setFontSize(cdp, want.fontSize);
  const got = await verify(cdp);
  await closePopover(cdp);
  await sleep(200);
  return got;
}

async function setFontSize(cdp: Session, size: number): Promise<void> {
  const changed = await cdp.evaluate<boolean>(`(() => {
    const sel = [...document.querySelectorAll("select")]
      .find((s) => [...s.options].every((o) => /^\\d+px$/.test(o.text)));
    if (!sel || Number(sel.value) === ${size}) return false;
    if (![...sel.options].some((o) => Number(o.value) === ${size})) return false;
    sel.value = "${size}";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (changed) await sleep(200);
}

/** What the controls now report, read back from the DOM. */
export async function verify(cdp: Session): Promise<DiffConfig> {
  const controls = await read(cdp);
  const fontSize = await cdp.evaluate<number>(`(() => {
    const sel = [...document.querySelectorAll("select")]
      .find((s) => [...s.options].every((o) => /^\\d+px$/.test(o.text)));
    return sel ? Number(sel.value) : 0;
  })()`);
  return {
    view: controls["Unified"]?.on ? "unified" : "split",
    lines: controls["All lines"]?.on ? "all" : "changes",
    wrap: controls["Line wrap"]?.on ?? false,
    whitespace: controls["Ignore whitespace"]?.on ?? false,
    fontSize,
  };
}

export const describe = (c: DiffConfig): string =>
  `${c.view}/${c.lines}/${c.wrap ? "wrap" : "nowrap"}/${c.whitespace ? "ws" : "raw"}/${c.fontSize}px`;
