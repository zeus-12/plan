import { useSyncExternalStore } from "react";

/**
 * User-configurable notification settings, persisted to localStorage so they
 * survive restarts and can be read synchronously by the module-level notifier
 * (which runs outside React). A tiny external store keeps the settings UI and
 * the notifier in sync without prop-drilling.
 */

export type SoundId = "off" | "ping" | "chime" | "marimba" | "glass";

export interface SoundOption {
  id: SoundId;
  label: string;
}

/** Presets offered in the settings picker (order = display order). */
export const SOUND_OPTIONS: SoundOption[] = [
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "marimba", label: "Marimba" },
  { id: "glass", label: "Glass" },
  { id: "off", label: "Off (silent)" },
];

export interface NotificationSettings {
  /** Master switch — notify when a session finishes. */
  enabled: boolean;
  /** Which chime to play; "off" shows the notification with no sound. */
  sound: SoundId;
}

const STORAGE_KEY = "plan.notifications";

const DEFAULTS: NotificationSettings = {
  enabled: true,
  sound: "chime",
};

let current: NotificationSettings = load();
const listeners = new Set<() => void>();

function load(): NotificationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Corrupt/unavailable storage — fall back to defaults, never crash.
  }
  return { ...DEFAULTS };
}

/** Synchronous read for the notifier (no React). */
export function getNotificationSettings(): NotificationSettings {
  return current;
}

export function setNotificationSettings(patch: Partial<NotificationSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Persistence is best-effort; the in-memory value still applies this run.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the settings UI. */
export function useNotificationSettings(): [
  NotificationSettings,
  (patch: Partial<NotificationSettings>) => void,
] {
  const settings = useSyncExternalStore(
    subscribe,
    getNotificationSettings,
    getNotificationSettings,
  );
  return [settings, setNotificationSettings];
}
