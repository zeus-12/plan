// A single document-level mirror of the live text selection into a custom
// highlight, so a drag-selection on a "tight selection" surface (the chat
// transcript, the file viewer, a diff) reads tight — text boxes only, no
// line-height leading — for the entire gesture. That matches the committed,
// per-character highlight those surfaces paint once the comment popover takes
// over, so there's no fat→thin snap on release. Native `::selection` (which
// fills the whole line box) is suppressed on those surfaces in globals.css; this
// paints the replacement.
//
// It MUST be a singleton, not a per-component effect. There is only ever one
// document selection and one global highlight registry entry, so exactly one
// listener may own it. When this ran per component, every mounted surface
// attached its own listener to the shared highlight; each cleared it and only
// the last-registered one re-added its range, so dragging in any surface but the
// most-recently-mounted painted nothing until release.
//
// A surface opts in by putting the `data-tight-selection` attribute on an
// ancestor of its selectable content. Installed once at renderer startup.

let installed = false;

export function installTightSelectionMirror(): void {
  if (installed) return;
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return;
  installed = true;

  const hl = new Highlight();
  CSS.highlights.set("tight-selection-live", hl);

  const inSurface = (node: Node | null): boolean => {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return !!el?.closest("[data-tight-selection]");
  };

  const sync = () => {
    hl.clear();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    // Both ends must sit inside a tight-selection surface. A selection can only
    // live in a painted (non-hidden) pane, so this also scopes to the visible
    // one without tracking a `visible` flag. A selection escaping the surface is
    // left to native paint (transparent inside the surface, so no double paint).
    if (!inSurface(sel.anchorNode) || !inSurface(sel.focusNode)) return;
    hl.add(sel.getRangeAt(0).cloneRange());
  };

  document.addEventListener("selectionchange", sync);
  // Never removed: a document-level singleton, cheap when idle (no surface
  // selection → clears an already-empty highlight and returns).
}
