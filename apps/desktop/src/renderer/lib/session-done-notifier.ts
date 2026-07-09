import { currentBusyIds, subscribeActivity } from "./terminal-activity-store";
import { isChatTerminalId } from "../../terminal-ids";
import { getNotificationSettings } from "./notification-settings";
import { playSound } from "./notification-sounds";
import { sessionLabel, sessionNavigator } from "./session-notify";
import { osNotify, pushToast } from "./toast-store";

/**
 * Global "a Claude session just finished" notifier.
 *
 * It runs at module scope (started once from the app root) so it watches EVERY
 * live chat session, not just the one on screen. The signal is the real one the
 * status dot uses: Claude's TUI shows an `esc to interrupt` hint while a turn is
 * in flight and drops it when the turn ends (see terminal-activity-store). When
 * a chat session leaves the working set, it just finished — so we fire once.
 *
 * This replaces the old output-timing signal, which mistook a scroll (Claude
 * repaints in response to wheel escapes) for work and fired a bogus "done" every
 * time you scrolled. The screen hint can't be faked that way.
 *
 * Two non-completions are deliberately NOT treated as "done":
 *   - the pty exited (session killed) — we drop it on the exit event so the
 *     disappearance isn't read as a finished turn;
 *   - an approval / selection menu is now on screen — Claude is waiting on the
 *     user, not done; the menu-detection path handles that case.
 */

// After the hint disappears, re-confirm the session is genuinely settled before
// firing — cheap insurance against a one-frame redraw blip mid-turn.
const SETTLE_MS = 350;

// Sessions that were working as of the previous observation.
let prevBusy = new Set<string>();
let unsub: (() => void) | null = null;
let unsubExit: (() => void) | null = null;

function fire(id: string) {
  const settings = getNotificationSettings();
  if (!settings.enabled) return;
  // We render the sound ourselves (the configured preset), so the OS
  // notification is silent — otherwise the system sound would double up.
  playSound(settings.sound);
  const label = sessionLabel(id);
  const navigate = sessionNavigator();
  // OS banner: reliably shown when the app is in the background. macOS
  // suppresses banners while the app is focused (and dev builds often don't
  // banner at all), so the in-app toast below is the focus-independent cue.
  // `tag`/`id` keyed to the session so a repeat for the same session refreshes
  // in place instead of stacking another banner/toast.
  osNotify("Claude is done", label, { silent: true, tag: id });
  pushToast({
    id,
    title: "Session finished",
    description: `Claude is done with “${label}”.`,
    actionLabel: navigate ? "View" : undefined,
    onAction: navigate ? () => navigate?.(id) : undefined,
  });
}

/**
 * A session dropped its working hint. Confirm it's really settled, and make sure
 * it didn't settle onto an approval menu (waiting on the user, not done), then
 * fire once.
 */
async function onFinished(id: string) {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  try {
    if ((await window.electronAPI.terminalBusyIds()).includes(id)) return; // blip / resumed
    const { state } = await window.electronAPI.terminalInputState(id);
    if (state === "selection") return; // approval/menu up — not done
  } catch {
    // Best effort — if the confirm calls fail, still notify rather than swallow.
  }
  fire(id);
}

function tick() {
  // Only chat ptys are Claude sessions — a scratch shell's TUI must never
  // trigger a "Claude is done".
  const now = new Set(currentBusyIds().filter(isChatTerminalId));
  for (const id of prevBusy) {
    if (!now.has(id)) void onFinished(id);
  }
  prevBusy = now;
}

/** Start the notifier. Idempotent; returns a stop function. */
export function startSessionDoneNotifier(): () => void {
  if (unsub) return stopSessionDoneNotifier;
  // Ask once if the OS notification permission is still undecided, so the
  // background banner can show. (Electron usually pre-grants this.)
  try {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  } catch {
    // No Notification API — toasts still cover it.
  }
  // A killed pty disappears from the busy set; drop it from prevBusy on the exit
  // event so that disappearance isn't mistaken for a finished turn.
  unsubExit = window.electronAPI.onTerminalExit((id) => {
    prevBusy.delete(id);
  });
  unsub = subscribeActivity(tick);
  return stopSessionDoneNotifier;
}

export function stopSessionDoneNotifier() {
  unsub?.();
  unsub = null;
  unsubExit?.();
  unsubExit = null;
  prevBusy = new Set();
}
