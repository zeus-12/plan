import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * macOS-style Ctrl+Tab switcher, centralized.
 *
 * Hold Ctrl and tap Tab to cycle a modal highlight forward (Ctrl+Shift+Tab
 * back). The highlight commits ONLY when Ctrl is released — holding Ctrl keeps
 * the modal open indefinitely, however long the pause between taps. Escape
 * cancels; losing window focus cancels too (so it can't get stuck).
 *
 * Two channels coexist — projects (Ctrl+Tab) and sessions (Ctrl+Shift+Tab) —
 * but there is a SINGLE window listener and a SINGLE active-state, so there's
 * no effect-ordering race or stuck-lock between component instances: on the
 * opening keystroke we pick the enabled channel whose `requireShift` matches.
 */

interface Channel {
  id: string;
  requireShift: boolean;
  isEnabled: () => boolean;
  getItems: () => unknown[];
  getCurrentIndex: () => number;
  commit: (item: unknown) => void;
}

let channels: Channel[] = [];
let active: { id: string; index: number } | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function step(i: number, len: number, dir: 1 | -1): number {
  return (i + dir + len) % len;
}

function close(commit: boolean) {
  if (active && commit) {
    const ch = channels.find((c) => c.id === active!.id);
    const item = ch?.getItems()[active.index];
    if (ch && item !== undefined) ch.commit(item);
  }
  active = null;
  emit();
}

// Ctrl+Tab can arrive twice — once from the renderer keydown and once from
// main's IPC forward (which exists because Chromium swallows Ctrl+Tab before
// the page sees it). Coalesce bursts so a single keystroke steps exactly once.
let lastCycleAt = 0;

/**
 * Advance the switcher one step. `shift` only chooses the channel on the
 * opening keystroke (Shift → sessions); it never reverses direction — every
 * tap moves forward (down the list).
 */
function cycle(shift: boolean) {
  const now = performance.now();
  if (now - lastCycleAt < 40) return;
  lastCycleAt = now;
  if (active) {
    const ch = channels.find((c) => c.id === active!.id);
    if (!ch) {
      close(false);
      return;
    }
    active = {
      id: active.id,
      index: step(active.index, ch.getItems().length, 1),
    };
    emit();
    return;
  }
  const ch = channels.find(
    (c) => c.isEnabled() && c.requireShift === shift && c.getItems().length > 0
  );
  if (!ch) return;
  active = {
    id: ch.id,
    index: step(ch.getCurrentIndex(), ch.getItems().length, 1),
  };
  emit();
}

function onKeyDown(e: KeyboardEvent) {
  // Renderer-side path. Chromium swallows plain Ctrl+Tab so this mostly catches
  // Ctrl+Shift+Tab; the main-process IPC forward (see install) covers Ctrl+Tab.
  // cycle() dedupes if both deliver the same keystroke.
  if (e.code === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    cycle(e.shiftKey);
    return;
  }
  if (active && e.key === "Escape") {
    e.preventDefault();
    close(false);
  }
}

// Releasing the held modifier commits instantly, like the macOS app switcher.
// (Shift is excluded — it only selects the channel.)
function onKeyUp(e: KeyboardEvent) {
  if (active && (e.key === "Control" || e.key === "Meta" || e.key === "Alt"))
    close(true);
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  // Safety net: if the window loses focus mid-gesture we may never see the Ctrl
  // keyup, so cancel rather than leave the modal stuck open.
  window.addEventListener("blur", () => {
    if (active) close(false);
  });
  // Cycling is driven from main via IPC — Chromium swallows Ctrl+Tab before the
  // page sees it, so main intercepts (before-input-event) and forwards here.
  window.electronAPI?.onSwitcherCycle?.((e) => cycle(e.shift));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

interface Options<T> {
  id: string;
  enabled: boolean;
  /** false: Ctrl+Tab · true: Ctrl+Shift+Tab. */
  requireShift: boolean;
  /** Items in display order (commit cycles through this exact order). */
  items: T[];
  /** Index of the active item — the cycle's starting point. */
  currentIndex: number;
  onCommit: (item: T) => void;
}

export function useTabSwitcher<T>(opts: Options<T>): {
  active: boolean;
  index: number;
} {
  install();
  // Latest options read through a ref so the registered channel always sees
  // current items/index without re-registering on every render.
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const ch: Channel = {
      id: opts.id,
      requireShift: opts.requireShift,
      isEnabled: () => ref.current.enabled,
      getItems: () => ref.current.items as unknown[],
      getCurrentIndex: () => ref.current.currentIndex,
      commit: (item) => ref.current.onCommit(item as T),
    };
    channels.push(ch);
    return () => {
      channels = channels.filter((c) => c !== ch);
      if (active?.id === opts.id) {
        active = null;
        emit();
      }
    };
  }, [opts.id, opts.requireShift]);

  const index = useSyncExternalStore(
    subscribe,
    () => (active && active.id === opts.id ? active.index : -1),
    () => -1
  );

  return { active: index >= 0, index: index < 0 ? 0 : index };
}
