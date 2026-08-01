import { useSyncExternalStore } from "react";
import { createPersistedValue } from "@/renderer/lib/external-value";
import {
  DEFAULT_CHAT_ENGINE,
  isChatEngineId,
  type ChatEngineCapabilities,
  type ChatEngineDescriptor,
  type ChatEngineId,
} from "@/common/chat-engines";

/**
 * Which engine new chats start with, and what each registered engine can do.
 *
 * The preference is a plain local setting (one global choice, like auto mode).
 * The capability table is NOT — it's fetched from main, because main is where
 * engines are registered and only it knows what's actually there. Nothing here
 * guesses: until the fetch lands, `capabilitiesFor` returns null and callers
 * must treat that as "don't know yet" rather than assuming a default shape.
 */

const preference = createPersistedValue<ChatEngineId>(
  "plan.chatEngine",
  (raw) => (isChatEngineId(raw) ? raw : DEFAULT_CHAT_ENGINE),
);

/** Synchronous read for non-React callers (the chat start path). */
export const getChatEngineId = preference.get;
export const setChatEngineId = preference.set;

/** React binding for the settings picker. */
export function useChatEngineId(): [
  ChatEngineId,
  (next: ChatEngineId) => void,
] {
  return [preference.useValue(), preference.set];
}

// ── Registered engines (from main) ───────────────────────────────────

let descriptors: ChatEngineDescriptor[] = [];
let fetched: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (fetched) return fetched;
  fetched = window.electronAPI
    .listChatEngines()
    .then((list) => {
      descriptors = list;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      // Leave the table empty — an engine we can't confirm exists must not be
      // presented as if it does. Callers gate on null capabilities.
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

/** Every registered engine. Empty until main has answered. */
export function useChatEngines(): ChatEngineDescriptor[] {
  return useSyncExternalStore(
    subscribe,
    () => descriptors,
    () => descriptors,
  );
}

/**
 * What `id` supports, or null when we haven't heard from main yet. Callers must
 * render capability-dependent surfaces only on an explicit `true` — a chat is
 * always started through main first, so by the time a surface matters this has
 * resolved.
 */
export function capabilitiesFor(
  id: ChatEngineId | null,
): ChatEngineCapabilities | null {
  if (!id) return null;
  return descriptors.find((d) => d.id === id)?.capabilities ?? null;
}

/** React binding for `capabilitiesFor`. */
export function useChatEngineCapabilities(
  id: ChatEngineId | null,
): ChatEngineCapabilities | null {
  const list = useChatEngines();
  if (!id) return null;
  return list.find((d) => d.id === id)?.capabilities ?? null;
}

/** Pull the engine table early so capabilities are known before they're needed. */
export function preloadChatEngines(): void {
  void load();
}
