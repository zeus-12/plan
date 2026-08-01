/**
 * Where each chat transcript was left scrolled, keyed by `<encoded>:<sessionId>`.
 * Module scope so a position survives both a tab switch (a hidden pane is
 * `display:none`, which drops the scroller's box and its offset) and a
 * `ProjectWorkspace` remount (switching worktrees tears every pane down).
 *
 * The position is an ANCHOR (a message row + where it sat under the pane's top
 * edge), not a raw offset: rows use `content-visibility`, so off-screen heights
 * are estimates until the browser renders them, and markdown/shiki/images
 * resolve after first paint. A restored `scrollTop` means something different
 * before and after that settles; a restored anchor doesn't.
 */
export interface ChatScrollPos {
  /** Reading the newest message — restore pins to the bottom instead of the
   *  anchor, so replies that landed while you were away are on screen. */
  atBottom: boolean;
  /** Fallback for when the anchor row is no longer in the transcript. */
  scrollTop: number;
  anchorUuid: string | null;
  /** Anchor row's top edge minus the pane's top edge, measured at
   *  `anchorScrollTop`. */
  anchorOffset: number;
  /** Scroll offset the anchor was measured at; any scrolling after that (the
   *  anchor is sampled once movement stops) is replayed as a pixel delta. */
  anchorScrollTop: number;
}

const positions = new Map<string, ChatScrollPos>();

export function chatScrollKey(encoded: string, sessionId: string): string {
  return `${encoded}:${sessionId}`;
}

export function getChatScroll(key: string): ChatScrollPos | null {
  return positions.get(key) ?? null;
}

export function setChatScroll(key: string, pos: ChatScrollPos): void {
  positions.set(key, pos);
}
