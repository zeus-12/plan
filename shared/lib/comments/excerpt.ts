/**
 * Shortens a selection to fit a character budget, keeping both ends.
 *
 * The popover's preview and the text sent to the agent both come from here, so
 * the two can never disagree about what is actually being sent — the preview IS
 * the payload, character for character.
 */

/** Openings matter more than endings for orienting a reader, so the head keeps
 *  the larger share of the budget. */
const HEAD_SHARE = 0.6;

/** These go into the sent text verbatim, in place of what was dropped — so they
 *  have to read plainly to whoever receives the message, not just in the UI. */
const CUT = "… omitted …";

function linesCut(n: number): string {
  return `… ${n} line${n === 1 ? "" : "s"} omitted …`;
}

export function excerpt(text: string, budget: number): string {
  const totalChars = text.length;
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalChars <= budget) return text;

  const headBudget = Math.floor(budget * HEAD_SHARE);
  const tailBudget = budget - headBudget;

  // Prefer cutting on line boundaries: half a line of code reads as corrupt,
  // and the reader can't tell truncation from a syntax error.
  if (totalLines > 2) {
    const head: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = line.length + 1;
      if (head.length > 0 && used + cost > headBudget) break;
      head.push(line);
      used += cost;
    }
    const tail: string[] = [];
    used = 0;
    for (let i = lines.length - 1; i >= head.length; i--) {
      const cost = lines[i].length + 1;
      if (tail.length > 0 && used + cost > tailBudget) break;
      tail.unshift(lines[i]);
      used += cost;
    }

    const elidedLines = totalLines - head.length - tail.length;
    const keptChars = head.join("\n").length + tail.join("\n").length;
    // A single line longer than its own budget would blow past it whole, so
    // fall through to the character cut rather than emit an oversized excerpt.
    if (elidedLines > 0 && keptChars <= budget) {
      return [...head, linesCut(elidedLines), ...tail].join("\n");
    }
  }

  return text.slice(0, headBudget) + CUT + text.slice(totalChars - tailBudget);
}
