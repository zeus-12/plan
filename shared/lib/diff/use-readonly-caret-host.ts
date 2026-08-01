"use client";

import { useCallback, useEffect, type RefObject } from "react";

/* ── Read-only caret host ───────────────────────────────────
 * Each diff region is a `contentEditable` host so it gets a real blinking
 * caret on click and native caret navigation (arrows / shift+arrows to extend
 * a selection), and so ⌘A is scoped by the browser to just that region's text
 * — surrounding chrome (gutters, the other split column) lives outside the
 * focused host, so it's never swept into the selection.
 *
 * It must stay strictly read-only: cancel every mutation at the source via the
 * native `beforeinput` event (covers typing, Enter, Backspace/Delete, format
 * shortcuts, IME commits and paste-insertion alike), plus paste/cut/drop. We
 * listen natively (not via React's onBeforeInput) because only the native
 * InputEvent is cancelable across the cases above. */

export function useReadonlyCaretHost(
  hostRefs: RefObject<HTMLElement | null>[],
  /** Re-attach when the hosts remount (e.g. a view-mode switch swaps refs). */
  remountKey: unknown,
): {
  contentEditable: true;
  suppressContentEditableWarning: true;
  spellCheck: false;
  role: "textbox";
  "aria-readonly": true;
  "aria-multiline": true;
  onCompositionStart: (e: React.CompositionEvent) => void;
  className: string;
} {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    const hosts = hostRefs
      .map((r) => r.current)
      .filter((el): el is HTMLElement => el !== null);
    for (const el of hosts) {
      el.addEventListener("beforeinput", block);
      el.addEventListener("paste", block);
      el.addEventListener("cut", block);
      el.addEventListener("drop", block);
    }
    return () => {
      for (const el of hosts) {
        el.removeEventListener("beforeinput", block);
        el.removeEventListener("paste", block);
        el.removeEventListener("cut", block);
        el.removeEventListener("drop", block);
      }
    };
    // The refs array is a fresh literal each render; remountKey is the real
    // re-attach signal (which refs exist only changes when the view remounts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remountKey]);

  // `beforeinput` can't cancel `insertCompositionText`, so an IME attempt on a
  // read-only host could mutate the DOM out from under React. That never makes
  // sense here (the host isn't typeable), so abort composition the instant it
  // starts by dropping focus — nothing is ever committed.
  const abortComposition = useCallback((e: React.CompositionEvent) => {
    (e.target as HTMLElement).blur();
  }, []);

  // Attributes that turn a region into a read-only caret host. `caret-color`
  // makes the caret visible against the diff background; the outline is
  // suppressed in favour of the focus ring on the surrounding wrapper. The
  // host is itself the horizontal scroller so native selection auto-scrolls it
  // when a drag passes the right edge.
  return {
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: false,
    role: "textbox",
    "aria-readonly": true,
    "aria-multiline": true,
    onCompositionStart: abortComposition,
    className:
      "overflow-x-auto outline-none [caret-color:var(--text)] [container-type:inline-size]",
  };
}
