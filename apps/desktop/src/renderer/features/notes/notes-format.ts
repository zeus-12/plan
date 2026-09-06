import type { SessionNote } from "@/common/shared-types";

/**
 * How a stash of notes turns into text you can paste into a chat.
 *
 * Pure and side-effect free so it's directly testable — the panel and the
 * keyboard shortcuts both format through here rather than each rolling their
 * own joiner.
 */

/** CRLF-normalized and trimmed. Nothing else is touched: a captured selection
 *  keeps its interior line breaks and indentation exactly as it was selected. */
export function normalizeNoteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Notes joined with a blank line between them — the plain "Copy". */
export function formatNotes(notes: SessionNote[]): string {
  return notes.map((n) => n.text.trim()).join("\n\n");
}

/**
 * Notes as a numbered list. Continuation lines are indented to sit under the
 * first line's text, so a multi-line note still reads as one item (and stays
 * valid markdown).
 */
export function formatNotesAsList(notes: SessionNote[]): string {
  const width = String(notes.length).length;
  return notes
    .map((n, i) => {
      const marker = `${String(i + 1).padStart(width, " ")}. `;
      const pad = " ".repeat(marker.length);
      const [first = "", ...rest] = n.text.trim().split("\n");
      return [marker + first, ...rest.map((l) => (l ? pad + l : ""))].join(
        "\n",
      );
    })
    .join("\n");
}
