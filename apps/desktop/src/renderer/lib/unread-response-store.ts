import { useSyncExternalStore } from "react";
import { isChatTerminalId, parseChatTerminalId } from "../../terminal-ids";

/**
 * Live "which chat sessions replied and haven't been looked at yet" signal —
 * the green counterpart to the amber approval store.
 *
 * A session is "unread" from the moment it finishes a turn (Claude drops its
 * `esc to interrupt` hint and does NOT settle onto an approval menu — the exact
 * verified event the done-notifier already fires on; see session-done-notifier)
 * until you actually look at it. It is deliberately NOT driven by an optimistic
 * guess: nothing marks a session unread on send, only a confirmed completion.
 *
 * "Looked at" is the real thing, not a proxy: the session's chat is the pane on
 * screen AND the OS window is focused. Reporting-in comes from the active
 * workspace (setViewedSession) and window focus/blur. So the badge clears when —
 * and only when — you're genuinely in front of the reply.
 *
 * Mirrors session-approval-store's shape (a set of chat ids + an `encoded`
 * projection for sidebar rollups). Kept separate from the approval and working
 * stores because the three states are independent: a session can be working,
 * then done-unread, and either may coexist with a sibling session's approval.
 */

// Chat ids that have replied and not yet been seen.
let unread = new Set<string>();
// Projected to target `encoded` cwds; rebuilt only when `unread` changes so the
// sidebar hook gets a stable reference between events (useSyncExternalStore
// requires it to avoid an infinite render loop).
let unreadEncoded = new Set<string>();
const listeners = new Set<() => void>();

// The chat id whose transcript is currently the on-screen pane (null when the
// active pane isn't a chat), and whether the OS window is focused. Together they
// mean "the user is looking at this session" — the only thing that clears an
// unread badge.
let viewedId: string | null = null;
let focused =
  typeof document !== "undefined" ? document.hasFocus() : true;

function emit() {
  listeners.forEach((l) => l());
}

function rebuildEncoded() {
  const encoded = new Set<string>();
  for (const id of unread) {
    const parsed = parseChatTerminalId(id);
    if (parsed) encoded.add(parsed.encoded);
  }
  unreadEncoded = encoded;
}

function add(id: string) {
  if (unread.has(id)) return;
  unread = new Set(unread);
  unread.add(id);
  rebuildEncoded();
  emit();
}

function clear(id: string) {
  if (!unread.has(id)) return;
  unread = new Set(unread);
  unread.delete(id);
  rebuildEncoded();
  emit();
}

/**
 * A session finished a turn (verified done, not parked on a menu). Badge it
 * unread — UNLESS you're already looking at it (its chat is on screen and the
 * window is focused), in which case you saw the reply land and there's nothing
 * to flag.
 */
export function markSessionReplied(id: string) {
  if (!isChatTerminalId(id)) return;
  if (focused && id === viewedId) return;
  add(id);
}

/**
 * Deliberately flag a session unread from a user action ("Mark as unread"),
 * even the one you're currently looking at. Unlike markSessionReplied this
 * ignores the focused+viewed guard — leaving yourself a reminder on the chat
 * you're about to step away from is the whole point. We also drop it as the
 * viewed session so merely refocusing the window won't instantly clear the
 * badge you just set; it clears the normal way once you leave and come back.
 */
export function markSessionUnread(id: string) {
  if (!isChatTerminalId(id)) return;
  if (id === viewedId) viewedId = null;
  add(id);
}

/** Clear a session's unread badge from a user action ("Mark as read"). */
export function clearSessionUnread(id: string) {
  clear(id);
}

/**
 * Report which chat is the on-screen pane (null when the center pane isn't a
 * chat). Called only by the active workspace. Viewing a session with the window
 * focused clears its unread badge.
 */
export function setViewedSession(id: string | null) {
  viewedId = id;
  if (focused && id) clear(id);
}

function onFocusChange(next: boolean) {
  focused = next;
  // Returning to the window while a chat is on screen means you've now seen it.
  if (focused && viewedId) clear(viewedId);
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => onFocusChange(true));
  window.addEventListener("blur", () => onFocusChange(false));
  // A resumed turn supersedes "replied — waiting on you": if it's working
  // again, it's no longer done. The session row already hides the green dot
  // while working, but clearing keeps the sidebar rollup honest too.
  window.electronAPI?.onTerminalActivity?.((id, activity) => {
    if (activity.busy) clear(id);
  });
  // A killed session isn't actionable. Deferred a tick so other exit listeners
  // (which prune their own sets) run first.
  window.electronAPI?.onTerminalExit?.((id) => {
    setTimeout(() => clear(id), 0);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Live "did this session reply and you haven't looked yet" flag for one id. */
export function useSessionHasUnread(id: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? unread.has(id) : false),
    () => false,
  );
}

/**
 * Read-only accessors mirroring session-approval-store, so an external consumer
 * (the attention switcher) can enumerate replied-but-unseen session ids and the
 * currently-viewed session without reaching into module internals. Kept minimal
 * and side-effect-free so the feature that uses them stays easy to remove.
 */
export function currentUnreadIds(): string[] {
  return [...unread];
}
export function subscribeUnread(listener: () => void): () => void {
  return subscribe(listener);
}
/** The chat id whose transcript is the on-screen pane, or null. */
export function getViewedId(): string | null {
  return viewedId;
}

/**
 * The set of target `encoded` cwds with at least one replied-but-unseen session.
 * The sidebar rolls its own encoded plus its worktrees' into one badge.
 */
export function useUnreadEncodedSet(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => unreadEncoded,
    () => unreadEncoded,
  );
}
