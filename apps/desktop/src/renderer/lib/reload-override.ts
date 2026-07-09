/**
 * ⌘R routing. Main forwards every ⌘R press to the renderer (see
 * before-input-event in main/index.ts) instead of reloading directly. A page
 * that fetches its own data — currently the PR view — claims the shortcut while
 * it's visible so ⌘R force-refreshes THAT page's data. When nothing claims it,
 * we do the ordinary full-app reload the user expects everywhere else.
 *
 * Overrides stack: registering returns an unregister that restores the previous
 * claimant, so switching between PR tabs (each claims while active) leaves the
 * right one in charge and tearing them all down falls back to reload.
 */
let current: (() => void) | null = null;

/** Claim ⌘R. Returns an unregister that restores the previous claimant. */
export function setReloadOverride(fn: () => void): () => void {
  const prev = current;
  current = fn;
  return () => {
    // Only restore if we're still the active claimant — guards against
    // out-of-order cleanup when several overrides mount/unmount.
    if (current === fn) current = prev;
  };
}

/** Invoked when main forwards a ⌘R press. */
export function handleReloadRequest() {
  if (current) current();
  else window.location.reload();
}
