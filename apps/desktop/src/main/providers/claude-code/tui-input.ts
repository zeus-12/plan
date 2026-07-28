import { writeTerminal } from "../../terminal";

/**
 * Writing INTO Claude Code's TUI. The pty layer moves bytes; this file knows
 * what shape those bytes have to be for Claude's input box to accept them.
 */

/**
 * Send a message to the Claude running in terminal `id` and submit it: the body
 * goes out as one bracketed paste, then Enter (CR) follows as a SEPARATE
 * keystroke shortly after. Claude's TUI ignores an Enter bundled into the same
 * input batch as a paste (anti-accidental-submit), so the separation is
 * required — the same approach tmux-based Claude drivers use.
 */
export function submitMessage(
  id: string,
  text: string,
  imagePaths: string[] = [],
) {
  let body = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  // Image paths go on their OWN line after the text, inside the bracketed paste.
  // That's the shape Claude's TUI recognises as an attached image (recording it
  // as "[Image: source: <path>]", which the transcript renders) — typing the
  // path inline as plain text instead just leaves it as literal path text.
  if (imagePaths.length > 0) {
    body = [body, imagePaths.join(" ")].filter(Boolean).join("\n\n");
  }
  if (body) writeTerminal(id, `\x1b[200~${body}\x1b[201~`);
  // With an image, give Claude time to read + attach the file first — an Enter
  // arriving mid-attach is dropped, which left the message sitting unsent.
  setTimeout(() => writeTerminal(id, "\r"), imagePaths.length > 0 ? 650 : 150);
}
