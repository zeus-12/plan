---
name: control-plan
description: "Drive and measure the Plan desktop app over CDP: launch it, click and scroll it, take screenshots, capture timeline traces and CPU profiles, and run a pass/fail performance suite. Use when verifying a renderer change in the real app, investigating scroll or open-chat lag, or when asked to measure, profile, or trace Plan rather than have a human test it."
---

# control-plan

Drives a running Plan desktop build over the Chrome DevTools Protocol and grades
what it does. No dependencies — Node's `fetch` and `WebSocket` speak CDP
directly.

```
pnpm -C skills/control-plan cli --help
```

Use this instead of asking the user to try a change. The point is that the
verification is mechanical and repeatable.

It lives in this repo at `skills/control-plan/` and is symlinked into
`~/.claude/skills/control-plan`, so Claude loads it by name while the source
stays version-controlled here. Edit it here; the link picks the change up.

TypeScript, run directly — Node 22+ strips the types, so there is no build step
and no dependency. `npm run typecheck` inside the folder checks it.

## Layout

| File             | Scope                                                  |
| ---------------- | ------------------------------------------------------ |
| `src/cdp.ts`     | transport: connect, guard, evaluate, synthetic input   |
| `src/app.ts`     | launch / stop / doctor                                 |
| `src/surface.ts` | **what a measurable surface is** — `CHAT`, `DIFF`      |
| `src/checks.ts`  | open cost, coverage, drift — written once, per surface |
| `src/find.ts`    | find toggle and typing cost — per surface              |
| `src/fixture.ts` | isolated workspace (shared) + per-surface content      |
| `cli.ts`         | command dispatch                                       |
| `test.ts`        | the deterministic run                                  |

The split exists so a second surface is nearly free. `checks.ts` never names
`.chat-transcript` or `[data-msg-row]`; it asks a `SurfaceSpec` for its scroller
and its rows. Point any command at one with `--surface chat|diff`.

## The deterministic run

```bash
pnpm -C skills/control-plan test            # fixture -> launch -> assert -> tear down
pnpm -C skills/control-plan test --keep     # leave the app up afterwards
pnpm -C skills/control-plan test --rows 4000 --budget-open 400 --budget-key 250
```

Seven checks, one command, non-zero exit on failure. It builds its own world
first — `src/fixture.ts` writes an isolated `HOME` with one project and a
synthetic chat — so it never reads or writes real chats, projects or comments,
and two runs produce byte-identical content.

Behaviour is asserted before any budget, because a blank transcript passes every
timing check ever written.

## Start here

```bash
CP="pnpm -C skills/control-plan cli"

$CP launch --mode preview --build   # build, start, wait for CDP
$CP doctor                          # is this instance worth driving?
$CP suite --match "fingerprint" --repeat 3 --budget 400
```

`doctor` is read-only and answers the only question that matters before
measuring: is the window really rendering, and which build is it. Run it first
whenever a number looks strange.

## Which build

`preview` is the built renderer and is what a user feels. `dev` runs through
Vite with React's development build, where `jsxDEV` and prop validation sit in
the hot path — timings there run about **2x** what a user sees. Every result
carries a `build` field. Never quote a dev number as a user-facing one.

```bash
$CP launch --mode preview --build    # rebuilds, then starts
$CP launch --mode dev                # HMR, for iterating on code
```

## What it refuses to do

These refusals exist because each one has already produced a wrong answer:

- **Measuring a hidden window.** A hidden or minimised window suspends
  `requestAnimationFrame`. A per-frame harness then hangs instead of failing,
  and whatever it eventually prints is about nothing. Every measuring command
  checks `document.hidden` and that a rAF actually returned, and refuses
  otherwise. Results carry the stamp.
- **Driving a window that is not Plan.** Another Electron app answering the same
  port gets measured in silence otherwise.
- **Killing a process it did not start.** `stop` only kills the pid it recorded
  at `launch`. Killing by port or name once took out an unrelated app.

## Measuring

```bash
$CP open --match "fingerprint" --repeat 3   # blocked frames while a chat opens
$CP drift --steps 30 --delta -160           # does content hold still while scrolling?
$CP coverage                                # every row in view has real content
$CP trace --match "fingerprint" --ms 8000   # style / layout / paint / event dispatch
$CP profile --match "fingerprint" --ms 8000 # top JS functions by self time
$CP throttle --cpu 4                        # expose marginal work
```

**Check correctness before believing a timing.** A blank transcript passes every
speed test ever written. `coverage` asserts that every row intersecting the
viewport actually has children and a non-zero height; `suite` runs it first and
fails the whole run if it does not hold.

**`trace` and `profile` answer different questions.** A CPU profile only sees
JavaScript. If frames are blocked while JS looks idle, the time is in style,
layout, paint or accessibility — only `trace` attributes that. Conversely, when
`trace` blames a long `FunctionCall`, `profile` names the function.

**Read `drift` correctly.** `scrollTop` totals and document growth are the wrong
measure: measuring rows legitimately changes the document height, and any
correction for that appears in those numbers as if it were damage. The honest
question is whether the anchor row travelled the distance the gesture asked for
— `visibleDriftPx`. Anything within a few px is clean.

## Driving the UI

Coordinates come from the app, not from guesses:

```bash
$CP buttons --match "diff"     # every visible control, with click coordinates
$CP click --match "fingerprint"
$CP wheel --steps 20 --delta -160
$CP screenshot --out /tmp/plan.png
```

`--match` resolves against visible button text, so a script survives the sidebar
moving. Fall back to `--x/--y` only when there is no text to match.

## Arbitrary probes

```bash
$CP eval --expr 'document.querySelectorAll("[data-msg-row]").length'
```

Useful selectors: `.chat-transcript` is the scroller, `[data-msg-row]` is a
message row, `[data-dline]` is a diff line.

## Gotchas that cost real time

- `electron-vite` rejects unknown top-level flags. Anything meant for Electron
  goes after `--`. `launch` already does this.
- `Page.bringToFront` raises the window but does not activate the app on macOS,
  and System Events is often not authorised. `launch`/`click` fall back to
  `open -a` on the Electron binary.
- Synthetic wheel events do not model macOS momentum. Do not grade a scroll on
  commanded-versus-travelled scroll distance; grade it on `visibleDriftPx`.
- A `WeakMap` keyed on message objects is a valid height cache here because
  `merge-session.ts` keeps the old object when a message is unchanged.

## Adding a surface

Adding the diff is a `SurfaceSpec` and a suite function, not a second copy of
the harness:

1. `src/surface.ts` already has a `DIFF` spec — its scroller and `[data-dline]`
   rows. Adjust the selectors if they move.
2. Give it fixture content in `src/fixture.ts` beside `chatSession` — a repo with
   a large file and a diff to open.
3. Add a `diffSuite` in `test.ts` next to `chatSuite`, calling the same
   `coverage`, `drift`, `measureOpen` and `findToggle`.

`--surface diff` already works for every measuring command.
