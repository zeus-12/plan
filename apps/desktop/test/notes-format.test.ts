import { describe, expect, it } from "vitest";
import type { SessionNote } from "@/common/shared-types";
import {
  formatNotes,
  formatNotesAsList,
  normalizeNoteText,
} from "@/renderer/features/notes/notes-format";

const note = (text: string): SessionNote => ({
  id: text,
  text,
  done: false,
  createdAt: 0,
});

describe("normalizeNoteText", () => {
  it("normalizes CRLF and strips surrounding blank lines", () => {
    expect(normalizeNoteText("\r\n\r\n  a\r\nb  \n\n")).toBe("a\nb");
  });

  it("keeps interior blank lines and indentation", () => {
    expect(normalizeNoteText("a\n\n  b")).toBe("a\n\n  b");
  });

  it("is empty for whitespace-only input", () => {
    expect(normalizeNoteText(" \n\t ")).toBe("");
  });
});

describe("formatNotes", () => {
  it("joins notes with a blank line", () => {
    expect(formatNotes([note("one"), note("two")])).toBe("one\n\ntwo");
  });
});

describe("formatNotesAsList", () => {
  it("numbers the notes", () => {
    expect(formatNotesAsList([note("one"), note("two")])).toBe(
      "1. one\n2. two",
    );
  });

  it("indents continuation lines under the first line's text", () => {
    expect(formatNotesAsList([note("one\nstill one"), note("two")])).toBe(
      "1. one\n   still one\n2. two",
    );
  });

  it("pads the markers so ten-plus items stay aligned", () => {
    const notes = Array.from({ length: 10 }, (_, i) => note(`n${i}`));
    const lines = formatNotesAsList(notes).split("\n");
    expect(lines[0]).toBe(" 1. n0");
    expect(lines[9]).toBe("10. n9");
  });

  it("leaves blank continuation lines blank rather than padded", () => {
    expect(formatNotesAsList([note("a\n\nb")])).toBe("1. a\n\n   b");
  });
});
