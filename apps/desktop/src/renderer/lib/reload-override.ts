/**
 * ⌘R routing. Main forwards every ⌘R press to the renderer (see
 * before-input-event in main/index.ts) instead of reloading directly. A surface
 * that fetches its own data claims the shortcut while it's visible so ⌘R
 * refreshes THAT data — the PR view, and the Diffs sidebar. When nothing claims
 * it, we do the ordinary full-app reload the user expects everywhere else.
 *
 * Claims carry a priority because two surfaces can be visible at once: an open
 * PR tab in the content pane and the Diffs list beside it. The content pane
 * wins — it's what the user is looking at. Within a priority the most recent
 * claim wins, so switching between PR tabs leaves the right one in charge.
 */
export type ReloadPriority = "sidebar" | "content";

const RANK: Record<ReloadPriority, number> = { sidebar: 0, content: 1 };

interface Claim {
  fn: () => void;
  rank: number;
  seq: number;
}

let claims: Claim[] = [];
let nextSeq = 0;

/** Claim ⌘R. Returns an unregister that drops this claim. */
export function setReloadOverride(
  fn: () => void,
  priority: ReloadPriority = "content",
): () => void {
  const claim: Claim = { fn, rank: RANK[priority], seq: nextSeq++ };
  claims.push(claim);
  return () => {
    claims = claims.filter((c) => c !== claim);
  };
}

/** Invoked when main forwards a ⌘R press. */
export function handleReloadRequest() {
  let best: Claim | null = null;
  for (const c of claims) {
    if (!best || c.rank > best.rank || (c.rank === best.rank && c.seq > best.seq))
      best = c;
  }
  if (best) best.fn();
  else window.location.reload();
}
