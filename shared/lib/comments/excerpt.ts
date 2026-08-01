/**
 * Shortens a selection to fit a character budget, keeping both ends.
 *
 * The popover's preview and the text sent to the agent both come from here, so
 * the two can never disagree about what is actually being sent — the preview IS
 * the payload, character for character.
 */

export interface Excerpt {
  /** Exactly what gets sent, elision marker included. */
  text: string;
  /** `text` is the whole selection, untouched. */
  complete: boolean;
  /** Whole lines dropped from the middle; 0 when the cut landed inside a line. */
  elidedLines: number;
  /** Characters dropped from the middle. */
  elidedChars: number;
  totalChars: number;
  totalLines: number;
}

/** Openings matter more than endings for orienting a reader, so the head keeps
 *  the larger share of the budget. */
const HEAD_SHARE = 0.6;

/** Goes into the sent text verbatim, in place of what was dropped — so it has
 *  to read plainly to whoever receives the message, not just in the UI. */
function marker(label: string): string {
  return `… ${label} omitted …`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function excerpt(text: string, budget: number): Excerpt {
  const totalChars = text.length;
  const lines = text.split("\n");
  const totalLines = lines.length;
  const base = { totalChars, totalLines };

  if (totalChars <= budget) {
    return { ...base, text, complete: true, elidedLines: 0, elidedChars: 0 };
  }

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
      return {
        ...base,
        text: [...head, marker(plural(elidedLines, "line")), ...tail].join(
          "\n",
        ),
        complete: false,
        elidedLines,
        elidedChars: totalChars - keptChars,
      };
    }
  }

  const elidedChars = totalChars - headBudget - tailBudget;
  return {
    ...base,
    text:
      text.slice(0, headBudget) +
      marker(plural(elidedChars, "char")) +
      text.slice(totalChars - tailBudget),
    complete: false,
    elidedLines: 0,
    elidedChars,
  };
}
