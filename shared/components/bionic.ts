/**
 * Bionic reading: bold the leading letters of each word so the eye anchors on
 * a fixation point and the brain fills in the rest, which many readers find
 * faster and less tiring.
 *
 * The weighting is ported from `text-vide` (MIT) — the open-source engine
 * behind most bionic-reading tools — so the "how many letters" question is
 * answered by a vetted reference rather than a guessed heuristic.
 * https://github.com/Gumball12/text-vide
 *
 * We run it as a rehype plugin over react-markdown's hast tree: it only splits
 * existing text nodes and wraps the leading slice in a <b>, so the rendered
 * `textContent` is byte-identical to the plain text. That matters because the
 * chat surface computes annotation/find offsets over `textContent` — bionic is
 * offset-safe for the same reason syntax highlighting is.
 */

/**
 * Per-fixation-point boundary tables from text-vide. Index = fixationPoint - 1.
 * For a word of length L, the number of *unbolded* trailing chars is the index
 * of the first boundary ≥ L; the leading remainder is bolded. Because these
 * thresholds climb slowly, short words are (near-)fully bolded and longer words
 * expose a smaller leading share.
 */
const FIXATION_BOUNDARY_LIST: readonly (readonly number[])[] = [
  [0, 4, 12, 17, 24, 29, 35, 42, 48],
  [1, 2, 7, 10, 13, 14, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49],
  [
    1, 2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39,
    41, 43, 45, 47, 49,
  ],
  [
    0, 2, 4, 5, 6, 8, 9, 11, 14, 15, 17, 18, 20, 0, 21, 23, 24, 26, 27, 29, 30,
    32, 33, 35, 36, 38, 39, 41, 42, 44, 45, 47, 48,
  ],
  [
    0, 2, 3, 5, 6, 7, 8, 10, 11, 12, 14, 15, 17, 19, 20, 21, 23, 24, 25, 26, 28,
    29, 30, 32, 33, 34, 35, 37, 38, 39, 41, 42, 43, 44, 46, 47, 48,
  ],
];

/**
 * Fixation point 3 is the classic ~50% look: single letters fully bolded, about
 * half of medium words, a smaller leading share of long words. It reads as
 * recognizable bionic without the heavier default (level 1) that over-bolds.
 * A single constant — bump it (1 = heaviest … 5 = lightest) to retune.
 */
const FIXATION_POINT = 3;

/** How many leading characters of a word to bold, per the text-vide table. */
function fixationLength(wordLength: number): number {
  const boundary =
    FIXATION_BOUNDARY_LIST[FIXATION_POINT - 1] ?? FIXATION_BOUNDARY_LIST[0];
  const fromLast = boundary.findIndex((b) => wordLength <= b);
  const len =
    fromLast === -1 ? wordLength - boundary.length : wordLength - fromLast;
  return Math.max(len, 0);
}

// A "word" is a run of letters/digits containing at least one letter (text-vide's
// CONVERTIBLE regex). Unicode-aware so it works beyond ASCII.
const WORD_RE = /[\p{L}\p{Nd}]*\p{L}[\p{L}\p{Nd}]*/gu;

// Minimal hast shapes — enough to walk and rewrite without pulling in a
// unist-util-visit dependency (react-markdown keeps those internal).
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Split one text node into a sequence of nodes: a <b> for each word's bolded
 * lead, with the untouched remainder (gaps, punctuation, word tails) preserved
 * verbatim as plain text so no characters are added, dropped, or reordered.
 */
function bionicizeText(value: string): HastNode[] {
  const out: HastNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(WORD_RE)) {
    const word = match[0];
    const start = match.index ?? 0;
    const boldLen = fixationLength(word.length);
    if (boldLen === 0) continue;
    if (start > cursor) {
      out.push({ type: "text", value: value.slice(cursor, start) });
    }
    out.push({
      type: "element",
      tagName: "b",
      // The anchor's impact comes from *contrast* with the rest of the word.
      // The prose renders at the soft `--prose-fg`; the lead is lifted to full
      // `--text` so it pops on the dark background, with a gentle 600 weight —
      // brightness does the anchoring, not a heavy bold. The remainder stays
      // exactly as readable as before (we only raise contrast, never dim text).
      properties: {
        className: ["bionic"],
        style: "font-weight:600;color:var(--text)",
      },
      children: [{ type: "text", value: word.slice(0, boldLen) }],
    });
    // The word's non-bold tail stays plain — it's emitted by the next slice.
    cursor = start + boldLen;
  }
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) });
  }
  return out;
}

/** Rewrite every prose text node under `node`, skipping code so it stays literal. */
function walk(node: HastNode): void {
  const kids = node.children;
  if (!kids) return;
  const next: HastNode[] = [];
  for (const child of kids) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...bionicizeText(child.value));
      continue;
    }
    // Inline/fenced code renders verbatim — never bionicize inside it.
    if (
      child.type === "element" &&
      child.tagName !== "code" &&
      child.tagName !== "pre"
    ) {
      walk(child);
    }
    next.push(child);
  }
  node.children = next;
}

/** rehype plugin: enable via react-markdown's `rehypePlugins`. */
export function rehypeBionic() {
  return (tree: HastNode) => {
    walk(tree);
  };
}
