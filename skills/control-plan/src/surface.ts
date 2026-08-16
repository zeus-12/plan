/**
 * What a measurable surface is.
 *
 * The checks in `checks.ts` never name `.chat-transcript` or `[data-msg-row]`.
 * They ask a SurfaceSpec for its scroller and its rows, so the same drift,
 * coverage and open-cost checks run against the chat transcript today and the
 * diff viewer once it is windowed too.
 *
 * Every field is a JavaScript expression evaluated in the page, because the
 * checks run there, in one round trip, rather than shuttling elements back.
 */
export interface SurfaceSpec {
  /** Identifier used in output and on the command line. */
  name: string;
  /** Expression returning the visible scroller element, or undefined. */
  scroller: string;
  /** Selector for one row inside the scroller. */
  row: string;
  /**
   * Expression over a bound `row` returning true when the row holds real
   * content rather than a reserved placeholder. Windowed surfaces render an
   * empty box for rows that are far away; this is what tells them apart.
   */
  filled: string;
  /**
   * Attribute naming a row's identity. A check that has to recognise the same
   * row twice — across a scroll, a fold, a rewrite — reads this rather than
   * holding the element, which windowing is free to unmount.
   */
  rowKey: string;
}

/** The chat transcript. */
export const CHAT: SurfaceSpec = {
  name: "chat",
  scroller: `[...document.querySelectorAll(".chat-transcript")].find((e) => e.clientHeight > 0)`,
  row: "[data-msg-row]",
  filled: "row.children.length > 0",
  rowKey: "data-msg-row",
};

/**
 * The diff viewer. Its scroller is whichever element actually scrolls and is
 * not the transcript, because a diff can be a tab of its own or nested inside a
 * chat plan card.
 */
export const DIFF: SurfaceSpec = {
  name: "diff",
  scroller: `(() => {
    const all = [...document.querySelectorAll("*")].filter((e) => {
      if (e.classList.contains("chat-transcript")) return false;
      const cs = getComputedStyle(e);
      return e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(cs.overflowY);
    });
    return all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  })()`,
  // `tr`, not any `[data-dline]`: the attribute is on the content cell too, and
  // a cell is not a row — measuring one where a row is meant reads the wrong
  // height and, in split view, picks a different element each time.
  row: "tr[data-dline]",
  filled: "row.children.length > 0 || (row.textContent || '').length > 0",
  rowKey: "data-dline",
};

export const SURFACES: Record<string, SurfaceSpec> = {
  [CHAT.name]: CHAT,
  [DIFF.name]: DIFF,
};

export function surfaceByName(name: string): SurfaceSpec {
  const s = SURFACES[name];
  if (!s) {
    throw new Error(
      `unknown surface ${JSON.stringify(name)}. Known: ${Object.keys(SURFACES).join(", ")}`,
    );
  }
  return s;
}
