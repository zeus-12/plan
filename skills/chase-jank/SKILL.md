---
name: chase-jank
description: "Turn a felt symptom — lag, stutter, jank, a freeze, a hitch, something that 'feels slow' — into a reproduction, a failing measurement, an agreed fix, and a verified before/after. Use whenever the report is about how the app feels rather than what it does, especially for scroll, typing, tab switching, opening a session, or folding."
---

# chase-jank

You have been handed a **symptom**, not a bug report. Someone felt something.
Your job is to turn that feeling into a number that starts red and ends green,
and to not touch the code until it is red.

The instrument is `skills/control-plan` — read its SKILL.md before you measure
anything. It launches the real app on its own synthetic fixture, drives it over
CDP, and grades what it does.

## The loop

Run it in order. Do not skip ahead, and do not collapse 4 into 5.

### 0. Write down the unit

Before anything else, name what the complaint is measured in. This is the step
that gets skipped, and skipping it is how a green suite ships a broken feature.

| They said                         | The unit                                     |
| --------------------------------- | -------------------------------------------- |
| "stutter", "hitch", "janky"       | dropped frames / longest blocked frame in ms |
| "lag" after an action             | ms from input to first painted frame         |
| "it jumps", "I lose my place"     | pixels the anchor moved                      |
| "black screen", "flash"           | frames with no content in the viewport       |
| "it's dancing", "it keeps moving" | distinct states while the input is idle      |
| "slow to open"                    | ms to first frame with real rows             |

Two of these can be true at once and fixing one does nothing for the other. A
fold can land the reader on exactly the right pixel and still drop 18 frames
getting there. **Assert in the unit they gave you.**

### 1. Reproduce it mechanically

Not by reasoning about the code. Launch the app on the fixture and make the
gesture happen. If you cannot make the app do the bad thing on demand, you have
nothing — say so and ask for the missing detail (which view, which settings,
how far scrolled, how big the file, how long they waited).

Reproduce it in the **preview** build. Dev-build numbers run about 2x and are
not what anyone feels.

### 2. Make a check that fails

Add it to `skills/control-plan/src/checks.ts` and wire it into `test.ts`. It has
to be red before the fix exists. A check written after the fix proves only that
you can write a check.

Record the red number. You will be quoting it later.

If an existing check covers the same gesture but a different unit, **do not
edit it into the new one** — the old assertion still has to hold. Add a second.

### 3. Diagnose with the instrument

`trace` for style / layout / paint / accessibility. `profile` for JavaScript.
They answer different questions: if frames are blocked while JS looks idle, the
time is not in JS and a profile will never show you.

Do not propose a cause you did not see in a trace, a profile, or a counter you
added. "Probably a re-render" is not a diagnosis.

### 4. Propose, then stop

Report: the repro, the red number, the cause with the evidence that names it,
the fix you intend, and what could break. Then wait. Do not implement.

This is a hard stop even when the fix looks obvious.

### 5. Implement

Only what the diagnosis calls for. One code path — no "fast case" branch that
skips the work under a threshold.

### 6. Re-run the same check

The one from step 2, unedited. Then run the **whole** suite, because a window
fix that helps one configuration routinely breaks another. Then
`pnpm run validate`.

If you edited the check between red and green, the result is worthless. Start
over.

### 7. Report

Give the red number and the green number from the same check, the configurations
it ran in, and — explicitly — the configurations it did **not** run in. State
anything you could not verify mechanically and why.

## Rules that have already cost real time here

- **A check only tests the configurations it runs in.** The diff has 16 settings
  combinations. A check pinned to `lines: "all"`, `fontSize: 13` has told you
  nothing about the other fifteen. Say which ones ran.
- **Never measure a hidden window.** rAF suspends; the harness will refuse, and
  it is right to.
- **Correctness before timing.** A blank pane passes every speed test ever
  written. Assert content is there first.
- **Never say fixed without both numbers.** "Should be better now" is not a
  result.
- **Do not commit.** Not the fix, not the check. Report and wait, every time.
- **Fixture data only.** Never point a run at a real chat, project or repo.

## Reporting a symptom to this skill

Useful:

> Ctrl+Tab between sessions in the same project. Noticeable lag when it lands on
> a tab — maybe half a second where nothing responds. Big sessions.

Not useful:

> switching is slow

The gesture, where, roughly how bad, and what was on screen. Everything else the
skill will go find.

## Worked example: the fold bounce

Kept because every step earned its place.

The report was "it stutters when I fold a function", and the suite was green.
The unit was wrong: `foldHold` measured where the reader ended up, and the
complaint — "up by a thing, then down by a thing, then it stops" — was about the
frames on the way. Restated as _the anchor row's offset on every frame_, and
added as `foldSettle` beside `foldHold` rather than folded into it.

Red on the first run, and only with line wrap on: 66px of excursion in unified,
**9,138px** in split, one reversal, and `restPx: 0` — a perfect landing every
time, which is exactly why the old check never noticed.

The cause was not guessable. A log of every `scrollTop` write showed a
`ResizeObserver` callback 7.5ms after the fold reporting `w: 1012->1012,
h: 881->881` — no resize at all. The effect that installs the observer had
`measure` in its dependency list; `measure` is rebuilt whenever `keys` changes,
which is every fold; and `observe()` always delivers one callback immediately.
That callback discarded every measured height and restored from the re-estimate,
one frame after the fold had already painted.

Two changes: the observer only acts on a **width** change, since only width
rewraps a row; and the scroll listener and observer now live behind a ref so
they outlive the callbacks and stop being re-installed per fold. 0px excursion,
0 reversals, in every configuration that had one.

## Known open, not yet chased

- **Ctrl+Tab session switch.** Reported as a noticeable hitch on landing.
