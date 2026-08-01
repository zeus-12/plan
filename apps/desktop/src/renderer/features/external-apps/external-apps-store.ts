import { useSyncExternalStore } from "react";
import { createPersistedValue } from "@/renderer/lib/external-value";
import type { ExternalApp } from "@/common/shared-types";

/**
 * The "Open in…" app list and which app is the default.
 *
 * The list is NOT a local guess — it comes from main, the only side that can
 * ask the OS what's installed. Until that answer lands the list is empty and
 * the UI renders nothing, rather than offering an app we haven't confirmed.
 *
 * The default is one global choice (the last app opened, shared by every
 * project and by the file/diff buttons), persisted locally.
 */

const preference = createPersistedValue<string | null>(
  "plan.openInApp",
  (raw) => (typeof raw === "string" ? raw : null),
);

let apps: ExternalApp[] = [];
let fetched: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  fetched ??= window.electronAPI
    .listExternalApps()
    .then((list) => {
      apps = list;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      // Leave it empty — an app we can't confirm must not be offered.
    });
  return fetched;
}

function subscribe(listener: () => void): () => void {
  void load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Installed apps. Empty until main has answered, and off macOS. */
export function useExternalApps(): ExternalApp[] {
  return useSyncExternalStore(
    subscribe,
    () => apps,
    () => apps,
  );
}

/**
 * The app the primary button opens: the stored pick, or the first installed app
 * when nothing is stored yet or the stored one has since been uninstalled. Null
 * until main has answered, so callers can't act on an unconfirmed app.
 */
function resolveDefault(list: ExternalApp[], stored: string | null) {
  return list.find((a) => a.id === stored) ?? list[0] ?? null;
}

export function getDefaultExternalApp(): ExternalApp | null {
  return resolveDefault(apps, preference.get());
}

/** The default app plus a setter that makes a pick sticky. */
export function useDefaultExternalApp(): [
  ExternalApp | null,
  (id: string) => void,
] {
  return [
    resolveDefault(useExternalApps(), preference.useValue()),
    preference.set,
  ];
}

export function preloadExternalApps(): void {
  void load();
}
