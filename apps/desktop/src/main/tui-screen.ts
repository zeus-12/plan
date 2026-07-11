import type { TerminalInputState } from "../shared-types";

/**
 * Claude Code TUI screen heuristics — pure functions over rendered screen rows
 * (no ptys, no sessions), so the signatures they encode can be unit-tested
 * against captured frames and fixed in one place when a CLI update changes the
 * TUI. terminal.ts reads the headless emulator and feeds the rows in.
 *
 * All heuristics on rendered glyphs, not a protocol — word any UI as a guess.
 */

// Claude Code blocks for input in two visually different shapes:
//
//  1. Yes/No-style menus (tool approval, plan accept): a NUMBERED option with a
//     ❯ pointer on the highlighted one, e.g. "❯ 1. Yes". A bare chevron is NOT
//     enough — the composer's own prompt is also "❯" (or "> ") in current
//     builds, so only "❯ <number>." means a menu (matching a bare chevron, as
//     an earlier version did, misread the normal composer as a menu).
//
//  2. AskUserQuestion pickers: options are highlighted by COLOR, not a ❯, so
//     shape (1) misses them entirely. What they reliably carry is a footer hint
//     line — "Enter to select", "Tab to switch questions", "Esc to cancel".
//     "Esc to cancel" also rides on the Yes/No prompts, so it doubles as a
//     general "an interactive prompt is up" signal. It is distinct from the
//     working spinner's "(esc to interrupt)" — different word, so no clash.
const SELECTION_RE =
  /❯\s*\d+[.)]|Esc to cancel|Enter to select|Tab to switch questions/;
const INPUT_BOX_RE = /[│|]\s*[>❯]\s/;

/**
 * EXPERIMENTAL, heuristic. Classify the bottom of a rendered screen as a
 * free-text input box, a selection menu, or unknown. Returns the matched lines
 * too, so the renderer can surface them for debugging/validation.
 */
export function classifyInputState(rows: string[]): {
  state: TerminalInputState;
  lines: string[];
} {
  // Only the bottom chunk matters (the box sits at the foot of the frame), and
  // ignoring the top avoids matching menu-like text in scrollback history.
  const tail = rows.slice(-16);
  const nonEmpty = tail.filter((l) => l.trim().length > 0);
  const text = nonEmpty.join("\n");
  let state: TerminalInputState = "unknown";
  if (SELECTION_RE.test(text)) state = "selection";
  else if (INPUT_BOX_RE.test(text)) state = "input";
  return { state, lines: nonEmpty.slice(-12) };
}

// While a Claude turn is in flight, its TUI footer renders an "esc to interrupt"
// hint, and drops it the instant the turn ends (returning to the idle prompt or
// stopping at an approval menu). That hint is the one true "working" signal:
//
//   - Unlike output timing, a scroll repaint can't fake it. Claude runs with
//     mouse tracking on, so scrolling sends wheel escapes to the pty and Claude
//     repaints — a real output stream that fooled the old timing-based signal
//     into "working" for as long as you scrolled. Scrolling never renders this
//     hint, so reading it instead is immune (verified against real frames).
//   - Unlike the "✻ Worked for 2s" summaries (which linger in scrollback), it's
//     only ever present live, so it never produces a stale match.
//
// The hint lives in the FOOTER — the live region BELOW the input box. Everything
// ABOVE the input box is transcript, which can legitimately contain the words
// "esc to interrupt" (e.g. a chat discussing this very feature — which once
// pinned a session to "working" forever), so we never scan there. The footer is
// NOT always the last row or two, though: while Claude runs sub-agents it draws
// an agent-management panel ("← for agents · ↓ to manage", then a list of
// agents) BELOW the hint, so a fixed "last N rows" window slid right past it and
// the status fell back to idle. Anchoring to the input box instead covers the
// whole footer no matter how tall that panel grows.
const WORKING_HINT_RE = /esc to interrupt/i;
// The input-prompt line — the boundary between transcript (above) and the live
// footer (below). Matches the bordered box ("│ > ", "│ ❯ ") and the borderless
// prompt ("› ", "❯ ", "> "). We take the LOWEST match: the real input box is
// always the bottom-most prompt-looking line (a markdown blockquote "> " in the
// transcript only ever sits above it, and scanning from there down still lands
// on the same footer).
const PROMPT_LINE_RE = /^\s*(?:[│|]\s*)?[>❯›](?:\s|$)/;
// Fallback footer window when no input prompt can be found (unexpected frame).
const FOOTER_ROWS = 3;

/** Whether a rendered screen currently shows Claude's working hint. */
export function screenIsBusy(rows: string[]): boolean {
  let boundary = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PROMPT_LINE_RE.test(rows[i])) {
      boundary = i;
      break;
    }
  }
  const region =
    boundary >= 0
      ? rows.slice(boundary + 1)
      : rows.filter((line) => line.trim().length > 0).slice(-FOOTER_ROWS);
  return region.some((line) => WORKING_HINT_RE.test(line));
}
