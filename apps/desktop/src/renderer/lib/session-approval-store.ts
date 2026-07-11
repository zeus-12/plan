import { useSyncExternalStore } from "react";
import { isChatTerminalId, parseChatTerminalId } from "../../terminal-ids";

/**
 * Live "which chat sessions are parked on an approval/selection menu" signal.
 *
 * The truth is Claude's rendered screen: an approval or plan/question menu draws
 * a numbered selector (or a footer like "Esc to cancel"), which main detects off
 * the headless emulator it keeps current for EVERY session — backgrounded ones
 * included — and gates on a live agent process (see tui-screen.ts /
 * terminal.ts). Event-fed, not polled: main evaluates after each output burst
 * and pushes only CHANGES over `terminal:activity`; one snapshot fetch seeds
 * the set on first subscribe. Fans out to:
 *   - the notifier (toast + OS banner when a session newly parks), and
 *   - sidebar badges (which project / worktree / session is waiting on you).
 *
 * This mirrors terminal-activity-store (the "working" signal); the two are kept
 * separate because a session that's waiting on a menu still repaints its prompt,
 * so it reads as "working" the whole time the menu is up — the two states
 * coexist and must be tracked independently.
 */

// Chat ids currently parked on a menu. Only `chat:` ptys are Claude sessions;
// main can't emit a non-chat menu here, but we filter anyway so a stray
// scratch-shell TUI never raises an approval badge.
let awaiting = new Set<string>();
// The same set projected to target `encoded` cwds — rebuilt only when `awaiting`
// changes, so `useApprovalEncodedSet` gets a stable reference between events
// (required by useSyncExternalStore to avoid an infinite render loop).
let awaitingEncoded = new Set<string>();
const listeners = new Set<() => void>();
let offs: Array<() => void> | null = null;
// Ids touched by a live event while the initial snapshot was in flight — the
// event is fresher than the snapshot, so the snapshot must not override them.
let touchedDuringSeed: Set<string> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function rebuildEncoded() {
  const encoded = new Set<string>();
  for (const id of awaiting) {
    const parsed = parseChatTerminalId(id);
    if (parsed) encoded.add(parsed.encoded);
  }
  awaitingEncoded = encoded;
}

function setAwaiting(id: string, waiting: boolean) {
  if (!isChatTerminalId(id)) return;
  if (waiting === awaiting.has(id)) return;
  awaiting = new Set(awaiting);
  if (waiting) awaiting.add(id);
  else awaiting.delete(id);
  rebuildEncoded();
  emit();
}

function start() {
  if (offs) return;
  touchedDuringSeed = new Set();
  offs = [
    window.electronAPI.onTerminalActivity((id, activity) => {
      touchedDuringSeed?.add(id);
      setAwaiting(id, activity.awaitingSelection);
    }),
    // A killed pty's menu isn't actionable; drop it. Deferred a tick so every
    // terminal:exit listener (the approval notifier prunes its notified set)
    // runs first.
    window.electronAPI.onTerminalExit((id) => {
      setTimeout(() => setAwaiting(id, false), 0);
    }),
  ];
  // Seed with the current fleet state; events arriving meanwhile win.
  void window.electronAPI
    .terminalSelectionIds()
    .then((ids) => {
      if (!offs) return; // stopped while the snapshot was in flight
      const seeded = new Set(awaiting);
      for (const id of ids.filter(isChatTerminalId)) {
        if (!touchedDuringSeed?.has(id)) seeded.add(id);
      }
      touchedDuringSeed = null;
      if (seeded.size !== awaiting.size) {
        awaiting = seeded;
        rebuildEncoded();
        emit();
      }
    })
    .catch(() => {
      // Main not ready / no terminals — events will fill the set in.
      touchedDuringSeed = null;
    });
}

function maybeStop() {
  if (listeners.size > 0) return;
  offs?.forEach((off) => off());
  offs = null;
  touchedDuringSeed = null;
  awaiting = new Set();
  awaitingEncoded = new Set();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    maybeStop();
  };
}

/** Subscribe to approval-set changes without binding to a single id. */
export function subscribeApproval(listener: () => void): () => void {
  return subscribe(listener);
}

/** Chat ids currently parked on an approval/selection menu (snapshot). */
export function currentApprovalIds(): string[] {
  return [...awaiting];
}

/** Live "is this session waiting on the user" flag for a single chat id. */
export function useSessionNeedsApproval(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? awaiting.has(id) : false),
    () => false,
  );
}

/**
 * The set of target `encoded` cwds (projects AND worktrees) that have at least
 * one session waiting on the user. The sidebar uses this to badge rows — a
 * project row rolls its own encoded plus its worktrees' encoded into one badge.
 */
export function useApprovalEncodedSet(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => awaitingEncoded,
    () => awaitingEncoded,
  );
}
