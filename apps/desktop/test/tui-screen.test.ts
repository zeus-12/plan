import { describe, expect, it } from "vitest";
import {
  classifyInputState,
  screenIsBusy,
} from "@/main/providers/claude-code/tui-screen";

// Frames are plain screen rows, bottom of the frame last — the same shape
// terminal.ts reads off the headless emulator.

const IDLE_FRAME = [
  "✻ Worked for 12s",
  "",
  "╭──────────────────────────────╮",
  "│ > Try “fix the failing test” │",
  "╰──────────────────────────────╯",
  "  ? for shortcuts",
];

const WORKING_FRAME = [
  "● Reading files…",
  "",
  "╭──────────────────────────────╮",
  "│ >                            │",
  "╰──────────────────────────────╯",
  "  ✻ Cerebrating… (esc to interrupt)",
];

describe("screenIsBusy", () => {
  it("sees the working hint in the footer below the input box", () => {
    expect(screenIsBusy(WORKING_FRAME)).toBe(true);
  });

  it("idle prompt with a lingering 'Worked for' summary is not busy", () => {
    expect(screenIsBusy(IDLE_FRAME)).toBe(false);
  });

  it("ignores 'esc to interrupt' in the transcript ABOVE the input box", () => {
    // A chat discussing this very feature once pinned a session to "working".
    const frame = [
      "● The hint is the text “esc to interrupt” in the footer.",
      "╭──────────────────────────────╮",
      "│ >                            │",
      "╰──────────────────────────────╯",
      "  ? for shortcuts",
    ];
    expect(screenIsBusy(frame)).toBe(false);
  });

  it("finds the hint above the sub-agent panel (footer taller than 2 rows)", () => {
    const frame = [
      "╭──────────────────────────────╮",
      "│ >                            │",
      "╰──────────────────────────────╯",
      "  ✻ Running… (esc to interrupt)",
      "  ← for agents · ↓ to manage",
      "  ◐ explorer · reading files",
      "  ◑ reviewer · verifying",
    ];
    expect(screenIsBusy(frame)).toBe(true);
  });

  it("anchors to the BOTTOM-most prompt line (markdown quote above)", () => {
    const frame = [
      "> a markdown blockquote in the transcript",
      "╭──────────────────────────────╮",
      "│ >                            │",
      "╰──────────────────────────────╯",
      "  ✻ Working… (esc to interrupt)",
    ];
    expect(screenIsBusy(frame)).toBe(true);
  });

  it("falls back to the last non-empty rows when no prompt is on screen", () => {
    expect(screenIsBusy(["cooking…", "(esc to interrupt)", "", ""])).toBe(true);
    expect(screenIsBusy(["plain shell output", "$", ""])).toBe(false);
  });

  it("empty screen is not busy", () => {
    expect(screenIsBusy([])).toBe(false);
  });
});

describe("classifyInputState", () => {
  it("classifies the free-text input box", () => {
    expect(classifyInputState(IDLE_FRAME).state).toBe("input");
  });

  it("classifies a numbered approval menu (❯ pointer)", () => {
    const frame = [
      "Do you want to make this edit?",
      "❯ 1. Yes",
      "  2. Yes, allow all edits during this session",
      "  3. No, and tell Claude what to do differently",
    ];
    expect(classifyInputState(frame).state).toBe("selection");
  });

  it("a bare chevron prompt is NOT a menu (composer's own prompt)", () => {
    const frame = ["❯ ", "  ? for shortcuts"];
    expect(classifyInputState(frame).state).not.toBe("selection");
  });

  it("classifies AskUserQuestion pickers via their footer hints", () => {
    for (const hint of [
      "Enter to select",
      "Tab to switch questions",
      "Esc to cancel",
    ]) {
      const frame = ["Which approach?", "  Option A", "  Option B", hint];
      expect(classifyInputState(frame).state).toBe("selection");
    }
  });

  it("the working spinner's '(esc to interrupt)' is NOT a menu", () => {
    expect(classifyInputState(WORKING_FRAME).state).toBe("input");
  });

  it("plain shell output is unknown", () => {
    const frame = ["$ ls", "README.md  src  package.json", "$"];
    expect(classifyInputState(frame).state).toBe("unknown");
  });

  it("only reads the bottom 16 rows — menu text in scrollback is ignored", () => {
    const frame = [
      "❯ 1. Yes", // old menu, scrolled far up
      ...Array.from({ length: 16 }, (_, i) => `output line ${i}`),
    ];
    expect(classifyInputState(frame).state).toBe("unknown");
  });

  it("returns the matched footer lines for debugging", () => {
    const { lines } = classifyInputState(IDLE_FRAME);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toContain("? for shortcuts");
  });
});
