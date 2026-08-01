import { createPersistedValue } from "@/renderer/lib/external-value";

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

const DEFAULTS: NotificationSettings = {
  enabled: true,
  sound: "chime",
};

const store = createPersistedValue<NotificationSettings>(
  "plan.notifications",
  (raw) => ({
    ...DEFAULTS,
    ...(raw && typeof raw === "object" ? raw : {}),
  }),
);

/** Synchronous read for the notifier (no React). */
export const getNotificationSettings = store.get;

export function setNotificationSettings(patch: Partial<NotificationSettings>) {
  store.set({ ...store.get(), ...patch });
}

/** React binding for the settings UI. */
export function useNotificationSettings(): [
  NotificationSettings,
  (patch: Partial<NotificationSettings>) => void,
] {
  return [store.useValue(), setNotificationSettings];
}
