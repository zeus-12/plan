import {
  currentApprovalIds,
  subscribeApproval,
} from "./session-approval-store";
import { getNotificationSettings } from "./notification-settings";
import { playSound } from "./notification-sounds";
import { sessionLabel, sessionNavigator } from "./session-notify";
import { osNotify, pushToast } from "./toast-store";

/**
 * Global "a Claude session is waiting on you" notifier.
 *
 * It runs at module scope (started once from the app root) so it watches EVERY
 * live chat session, not just the one on screen — the whole point of this
 * feature: a session that parks on an approval/plan/question menu in a project
 * or worktree you're not looking at should still reach you. The signal is the
 * approval store (Claude's rendered menu, gated on a live agent).
 *
 * The workspace on screen additionally reveals its own chat tab when its
 * selected session parks (see project-workspace `awaitingSelection`); that's a
 * local convenience. This notifier owns the ACTUALLY-important cross-project
 * cue: the toast + OS banner + sound.
 */

// Sessions we've already notified for this parked-state, so a menu that stays up
// across many polls fires once. Cleared when the session leaves the set, so the
// next distinct prompt notifies again.
let notified = new Set<string>();
let unsub: (() => void) | null = null;
let unsubExit: (() => void) | null = null;

function fire(id: string) {
  const settings = getNotificationSettings();
  if (!settings.enabled) return;
  // Render the configured sound ourselves, so the OS banner stays silent (no
  // doubled system sound). Approvals block progress, so they're worth a sound.
  playSound(settings.sound);
  const label = sessionLabel(id);
  const navigate = sessionNavigator();
  // `tag`/`id` keyed to the session so a repeat refreshes in place rather than
  // stacking. macOS suppresses banners while focused, so the toast is the
  // focus-independent cue.
  osNotify("Approval needed", label, { silent: true, tag: id });
  pushToast({
    id,
    title: "Waiting on you",
    description: `Claude needs your input in “${label}”.`,
    actionLabel: navigate ? "View" : undefined,
    onAction: navigate ? () => navigate(id) : undefined,
  });
}

function tick() {
  const now = new Set(currentApprovalIds());
  for (const id of now) {
    if (!notified.has(id)) fire(id);
  }
  // Drop sessions that are no longer parked so their next prompt re-notifies.
  notified = now;
}

/** Start the notifier. Idempotent; returns a stop function. */
export function startSessionApprovalNotifier(): () => void {
  if (unsub) return stopSessionApprovalNotifier;
  // An ended session simply disappears from the approval set; nothing to
  // notify. Drop it from `notified` on the exit event so the id doesn't linger.
  unsubExit = window.electronAPI.onChatExit((id) => {
    notified.delete(id);
  });
  unsub = subscribeApproval(tick);
  return stopSessionApprovalNotifier;
}

export function stopSessionApprovalNotifier() {
  unsub?.();
  unsub = null;
  unsubExit?.();
  unsubExit = null;
  notified = new Set();
}
