import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * macOS/Windows-style modifier-held switcher, centralized.
 *
 * Hold Ctrl and tap a trigger key to cycle a modal highlight; the highlight
 * commits ONLY when Ctrl is released — holding Ctrl keeps the modal open
 * indefinitely, however long the pause between taps. HOLDING the trigger key
 * down auto-cycles: the OS key-repeat stream drives one step per repeat (see
 * cycle's throttle for the rate cap), and it stops the instant you let go.
 * Shift reverses direction for that tap. Escape cancels; losing window focus
 * cancels too (so it can't get stuck).
 *
 * Several channels coexist — content-pane tabs (Ctrl+Tab) and the unified
 * projects+worktrees switcher (Ctrl+`) — but there
 * is a SINGLE window listener and a SINGLE active-state, so there's no
 * effect-ordering race or stuck-lock between component instances: on the
 * opening keystroke we pick the enabled channel whose trigger key matches.
 *
 * Items are expected in already-resolved display order (see mru-store), with
 * the current item first; the first forward tap therefore lands on index 1,
 * the most-recently-used OTHER item.
 */

interface Channel {
  id: string;
  /** KeyboardEvent.code that opens this channel, e.g. "Tab" | "Backquote". */
  triggerCode: string;
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

// A keystroke can arrive twice — once from the renderer keydown and once from
// main's IPC forward (which exists because Chromium swallows Ctrl+Tab before
// the page sees it). Coalesce bursts so a single keystroke steps exactly once.
// This same throttle caps the hold-to-repeat rate: when the trigger key is held,
// the OS emits a fast key-repeat stream and we step at most once per window.
const REPEAT_THROTTLE_MS = 40;
let lastCycleAt = 0;

/**
 * Advance the switcher one step. `code` selects the channel on the opening
 * keystroke; `dir` is the step direction (1 forward / -1 backward, chosen by
 * Shift) and applies to every tap, so a held gesture can mix directions.
 */
function cycle(code: string, dir: 1 | -1) {
  const now = performance.now();
  if (now - lastCycleAt < REPEAT_THROTTLE_MS) return;
  lastCycleAt = now;
  if (active) {
    const ch = channels.find((c) => c.id === active!.id);
    if (!ch) {
      close(false);
      return;
    }
    active = {
      id: active.id,
      index: step(active.index, ch.getItems().length, dir),
    };
    emit();
    return;
  }
  const ch = channels.find(
    (c) => c.isEnabled() && c.triggerCode === code && c.getItems().length > 0,
  );
  if (!ch) return;
  active = {
    id: ch.id,
    index: step(ch.getCurrentIndex(), ch.getItems().length, dir),
  };
  emit();
}

function onKeyDown(e: KeyboardEvent) {
  // Renderer-side path. Chromium swallows plain Ctrl+Tab so this mostly catches
  // Ctrl+Shift+Tab and the Ctrl+` (Backquote) project combos; the main-process
  // IPC forward (see install) covers the swallowed Ctrl+Tab. cycle() dedupes if
  // both deliver the same keystroke.
  // Open/step whichever registered channel claims this key code (Tab, Backquote,
  // Backslash, …). Channel-driven so adding a switcher needs no edit here.
  // Ctrl drives every channel. Cmd also drives the backtick project+worktree
  // switcher since that's the macOS-natural key — but NOT Tab (Cmd+Tab is the OS
  // app switcher) and NOT digits (Cmd+1‑4 switch sidebar tabs).
  const mod =
    e.ctrlKey || (e.metaKey && e.code !== "Tab" && !e.code.startsWith("Digit"));
  if (mod && !e.altKey && channels.some((c) => c.triggerCode === e.code)) {
    e.preventDefault();
    cycle(e.code, e.shiftKey ? -1 : 1);
    return;
  }
  if (active && e.key === "Escape") {
    e.preventDefault();
    close(false);
  }
}

// Releasing the held modifier commits instantly, like the OS app switcher.
// (Shift is excluded — it only sets the step direction.)
function onKeyUp(e: KeyboardEvent) {
  if (active && (e.key === "Control" || e.key === "Meta" || e.key === "Alt"))
    close(true);
}

/** Mouse hover in the overlay moves the highlight, like a keyboard step. */
export function switcherHover(index: number) {
  if (!active || active.index === index) return;
  active = { id: active.id, index };
  emit();
}

/** Mouse click in the overlay commits that item immediately. */
export function switcherCommit(index: number) {
  if (!active) return;
  active = { id: active.id, index };
  close(true);
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture phase: window sees the key BEFORE any descendant (e.g. an xterm
  // terminal pane), so a focused input can't swallow the switcher combo.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Safety net: if the window loses focus mid-gesture we may never see the Ctrl
  // keyup, so cancel rather than leave the modal stuck open.
  window.addEventListener("blur", () => {
    if (active) close(false);
  });
  // Cycling is driven from main via IPC — Chromium swallows Ctrl+Tab before the
  // page sees it, so main intercepts (before-input-event) and forwards here.
  window.electronAPI?.onSwitcherCycle?.((e) => cycle(e.key, e.shift ? -1 : 1));
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
  /** KeyboardEvent.code that opens this channel: "Tab" or "Backquote". */
  triggerCode: string;
  /** Items in display order — MRU-ordered, current item first. */
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
      triggerCode: opts.triggerCode,
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
  }, [opts.id, opts.triggerCode]);

  const index = useSyncExternalStore(
    subscribe,
    () => (active && active.id === opts.id ? active.index : -1),
    () => -1,
  );

  return { active: index >= 0, index: index < 0 ? 0 : index };
}
