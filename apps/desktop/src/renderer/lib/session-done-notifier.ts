import {
  idleMs,
  isWorking,
  knownTerminalIds,
  subscribeActivity,
} from "./terminal-activity-store";
import { getNotificationSettings } from "./notification-settings";
import { playSound } from "./notification-sounds";
import { osNotify, pushToast } from "./toast-store";

/**
 * Global "a Claude session just finished" notifier.
 *
 * It runs at module scope (started once from the app root) so it watches EVERY
 * live chat pty, not just the one currently on screen. The signal is the same
 * fact the header's status dot uses: the pty's output stream. While Claude
 * works, its TUI repaints and output flows (`isWorking`); when it settles to the
 * idle prompt, output stops.
 *
 * Edge-triggered + debounced to avoid spam: a session must transition
 * Working -> idle and STAY idle for IDLE_DONE_MS before it fires once. It then
 * disarms until the session works again. Short mid-turn pauses (between tool
 * calls, while thinking) don't reach the threshold, so they don't fire.
 *
 * Known trade-off (we iterate as bugs surface): output also stops when Claude
 * is blocked on an approval, so a long approval wait can read as "done". The
 * separate menu-detection path already nudges the user toward the terminal in
 * that case.
 */

// A chat pty's id is `chat:<encoded>:<sessionId>`; only these are Claude
// sessions. Scratch shells (`term:...`) must never trigger a "Claude is done".
const CHAT_PREFIX = "chat:";

// How long output must stay stopped past the working window before we call it
// done. WORKING_WINDOW_MS (1.5s) + this is the total quiet time. Tunable.
const IDLE_DONE_MS = 4000;

interface SessionState {
  /** Armed: we've observed this session working since it last fired. */
  sawWorking: boolean;
}

const states = new Map<string, SessionState>();
let unsub: (() => void) | null = null;

/**
 * Resolve a chat pty id to a human label for the notification body. Set by the
 * watcher from the live projects list; falls back to the raw id fragment.
 */
let resolveLabel: (id: string) => string = defaultLabel;

function defaultLabel(id: string): string {
  // chat:<encoded>:<sessionId> — show the short session id as a last resort.
  const sessionId = id.split(":").pop() ?? id;
  return sessionId.slice(0, 8);
}

export function setSessionLabelResolver(fn: (id: string) => string) {
  resolveLabel = fn;
}

// Jump to the session a notification is about. Set by the app root (it owns the
// project/session navigation); null until then.
let navigate: ((id: string) => void) | null = null;

export function setSessionNavigator(fn: (id: string) => void) {
  navigate = fn;
}

function fire(id: string) {
  const settings = getNotificationSettings();
  if (!settings.enabled) return;
  // We render the sound ourselves (the configured preset), so the OS
  // notification is silent — otherwise the system sound would double up.
  playSound(settings.sound);
  const label = resolveLabel(id);
  // OS banner: reliably shown when the app is in the background. macOS
  // suppresses banners while the app is focused (and dev builds often don't
  // banner at all), so the in-app toast below is the focus-independent cue.
  osNotify("Claude is done", label, { silent: true });
  pushToast({
    text: `Claude finished — ${label}`,
    actionLabel: navigate ? "View" : undefined,
    onAction: navigate ? () => navigate?.(id) : undefined,
  });
}

function tick() {
  const live = new Set<string>();
  for (const id of knownTerminalIds()) {
    if (!id.startsWith(CHAT_PREFIX)) continue;
    live.add(id);
    let st = states.get(id);
    if (!st) {
      st = { sawWorking: false };
      states.set(id, st);
    }
    if (isWorking(id)) {
      // Working again — (re)arm. A session that's busy at startup arms here and
      // only fires once it later settles, so we never notify about history.
      st.sawWorking = true;
    } else if (st.sawWorking && idleMs(id) >= IDLE_DONE_MS) {
      st.sawWorking = false;
      fire(id);
    }
  }
  // Forget sessions whose pty has gone (exit drops them from knownTerminalIds)
  // so a killed-while-working session can't fire on a later tick.
  for (const id of states.keys()) {
    if (!live.has(id)) states.delete(id);
  }
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
  unsub = subscribeActivity(tick);
  return stopSessionDoneNotifier;
}

export function stopSessionDoneNotifier() {
  unsub?.();
  unsub = null;
  states.clear();
}
