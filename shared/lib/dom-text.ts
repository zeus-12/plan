/**
 * Character-offset ↔ DOM mapping over an element's text nodes — the one module
 * that translates between "offset into a surface's text" and concrete DOM
 * nodes/Ranges. Every comment surface (chat transcript, file viewer, diff,
 * doc view) anchors selections and repaints highlights through these walks, so
 * the boundary-clamping subtleties live once.
 *
 * Two offset spaces exist, and they must never be mixed:
 *
 * - The RAW space ({@link offsetOfBoundary}): every text character under the
 *   root counts. Robust when a boundary sits on an element node (a
 *   triple-click's end boundary does) because the browser flattens the range.
 *
 * - The FILTERED space (everything taking `skipAttr`): subtrees marked with
 *   that attribute contribute no characters, so a comment can't swallow a
 *   collapsed block's hidden dump. Offsets computed with one `skipAttr` are
 *   only meaningful to other calls using the same value.
 */

/** Nearest self-or-ancestor element carrying `attr`, or null. */
export function ancestorWithAttr(node: Node, attr: string): HTMLElement | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : node.parentElement;
  while (el) {
    if (el.hasAttribute(attr)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * The rect of a selection's last visible line — the last of `getClientRects()`
 * with real area. `getBoundingClientRect()` unions in a zero-size rect at the
 * range's end boundary, which for a tall multi-line selection can sit far below
 * the last line and mis-place anything anchored to it.
 */
export function lastLineRect(range: Range): DOMRect {
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  return rects[rects.length - 1] ?? range.getBoundingClientRect();
}

/**
 * Characters within `root` before the boundary (node, nodeOffset), in the RAW
 * space. A Range lets the browser flatten the root's nested span stack and
 * resolve element-node boundaries — a triple-click ends at the *start* of the
 * next line's element, which a manual text-node walk mis-counts as that whole
 * line's length, bleeding the selection onto the line below.
 */
export function offsetOfBoundary(
  root: Element,
  node: Node,
  nodeOffset: number,
): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  try {
    r.setEnd(node, nodeOffset);
  } catch {
    return -1;
  }
  return r.toString().length;
}

/** Text-node walker over `root`, rejecting any subtree marked `skipAttr`. */
function textWalker(root: HTMLElement, skipAttr?: string): TreeWalker {
  return document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    skipAttr
      ? {
          acceptNode(node) {
            for (
              let el = node.parentElement;
              el && el !== root;
              el = el.parentElement
            ) {
              if (el.hasAttribute(skipAttr)) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      : null,
  );
}

/** The concatenated text of `root` in the FILTERED space. */
export function textOf(root: HTMLElement, skipAttr?: string): string {
  const walker = textWalker(root, skipAttr);
  let s = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    s += n.textContent ?? "";
  return s;
}

/**
 * Characters before the boundary (node, nodeOff) in the FILTERED space, or -1
 * when the node isn't one of root's (unskipped) text nodes. Use
 * {@link offsetOfBoundary} instead when no filtering is needed — it also
 * handles element-node boundaries.
 */
export function offsetWithin(
  root: HTMLElement,
  node: Node,
  nodeOff: number,
  skipAttr?: string,
): number {
  const walker = textWalker(root, skipAttr);
  let acc = 0;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    if (cur === node) return acc + nodeOff;
    acc += cur.textContent?.length ?? 0;
    cur = walker.nextNode();
  }
  return -1;
}

/**
 * Character offsets [start, end) of the part of `range` that lies inside
 * `root`, in the FILTERED space.
 *
 * Walks `root`'s text nodes and keeps only the portion each one contributes to
 * the selection, so endpoints that fall outside `root` (or on element nodes, as
 * a triple-click's end boundary does) are clamped to what's actually covered
 * rather than to the whole part. Returns null if the range covers no text here.
 */
export function selectedOffsetsWithin(
  root: HTMLElement,
  range: Range,
  skipAttr?: string,
): { start: number; end: number } | null {
  const walker = textWalker(root, skipAttr);
  let acc = 0;
  let start = -1;
  let end = -1;
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const len = cur.textContent?.length ?? 0;
    if (len > 0 && range.intersectsNode(cur)) {
      const localStart = cur === range.startContainer ? range.startOffset : 0;
      const localEnd = cur === range.endContainer ? range.endOffset : len;
      // Skip a node the range only touches at a boundary (no chars covered).
      if (localStart < localEnd) {
        if (start === -1) start = acc + localStart;
        end = acc + localEnd;
      }
    }
    acc += len;
    cur = walker.nextNode();
  }
  return start === -1 ? null : { start, end };
}

/** Build a DOM Range for [start, end) offsets in the FILTERED space. */
export function rangeForOffsets(
  root: HTMLElement,
  start: number,
  end: number,
  skipAttr?: string,
): Range | null {
  const walker = textWalker(root, skipAttr);
  let acc = 0;
  let startNode: Node | null = null;
  let startNodeOff = 0;
  let endNode: Node | null = null;
  let endNodeOff = 0;
  let n = walker.nextNode();
  while (n) {
    const len = n.textContent?.length ?? 0;
    if (startNode === null && acc + len > start) {
      startNode = n;
      startNodeOff = start - acc;
    }
    if (acc + len >= end) {
      endNode = n;
      endNodeOff = end - acc;
      break;
    }
    acc += len;
    n = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, startNodeOff);
    range.setEnd(endNode, endNodeOff);
  } catch {
    return null;
  }
  return range;
}

export interface TextSegment {
  node: Text;
  start: number;
}

/**
 * Snapshot `root`'s FILTERED text plus the text-node segments it came from, so
 * later match offsets map back to DOM Ranges via {@link rangeFromSegments}
 * without re-walking. The snapshot is only valid until the DOM changes.
 */
export function collectTextSegments(
  root: HTMLElement,
  skipAttr?: string,
): { text: string; segs: TextSegment[] } {
  const walker = textWalker(root, skipAttr);
  const segs: TextSegment[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    segs.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { text, segs };
}

/** Build a DOM Range for [start, end) over collected segments. */
export function rangeFromSegments(
  segs: TextSegment[],
  start: number,
  end: number,
): Range | null {
  if (segs.length === 0 || end <= start) return null;
  const seg = (off: number) => {
    let lo = 0;
    let hi = segs.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start <= off) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return segs[ans];
  };
  const a = seg(start);
  const b = seg(end - 1);
  const r = document.createRange();
  try {
    r.setStart(a.node, Math.min(start - a.start, a.node.data.length));
    r.setEnd(b.node, Math.min(end - b.start, b.node.data.length));
  } catch {
    return null;
  }
  return r;
}
