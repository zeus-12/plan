import { useSyncExternalStore } from "react";
import { getChatEngineId } from "./chat-engine-settings";
import type { ChatEngineId, StartChatResult } from "../../chat-engines";

/**
 * Which chats have a live driver, and which engine is behind each.
 *
 * Module scope (like terminal-store) so the set survives a workspace remount:
 * switching projects and coming back finds the same sessions still connected.
 *
 * Membership is confirmed, never assumed — a chat lands here only after main
 * says it started, and leaves on `chat:exit`. That's what the composer's
 * enabled state and the terminal pane both key off, so neither can claim a
 * session is connected before it is.
 */

interface StartedChat {
  engine: ChatEngineId;
  cwd: string;
}

let started = new Map<string, StartedChat>();
// Starts in flight, so a double-click (or a reveal racing a connect) results in
// one driver rather than two attempts at the same session.
const pending = new Map<string, Promise<StartChatResult>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function drop(chatId: string) {
  if (!started.has(chatId)) return;
  started = new Map(started);
  started.delete(chatId);
  emit();
}

// Subscribed at module load, not on first React subscriber: this is the single
// teardown path — whatever ends a chat (the user quitting it, the process
// dying, an archive kill) arrives as one exit — and it has to be heard whether
// or not something happens to be rendering the session right then.
if (typeof window !== "undefined") {
  window.electronAPI?.onChatExit?.(drop);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start driving `chatId` (or reattach to a driver that's already up). Resolves
 * with what main actually did, including which engine took it — an already-live
 * chat keeps its own engine regardless of the current preference.
 */
export function startChat(
  chatId: string,
  opts: {
    encoded: string;
    sessionId: string;
    isNew: boolean;
    autoMode: boolean;
  },
): Promise<StartChatResult> {
  const inFlight = pending.get(chatId);
  if (inFlight) return inFlight;

  const run = window.electronAPI
    .startChat(chatId, { ...opts, engine: getChatEngineId() })
    .then((res) => {
      // An error means nothing is driving the chat — don't record it as live.
      if (!res.error) {
        started = new Map(started);
        started.set(chatId, { engine: res.engine, cwd: res.cwd });
        emit();
      }
      return res;
    })
    .finally(() => {
      if (pending.get(chatId) === run) pending.delete(chatId);
    });

  pending.set(chatId, run);
  return run;
}

/** End a chat's driver. The exit event is what actually removes it from here. */
export function stopChat(chatId: string): void {
  window.electronAPI.stopChat(chatId);
}

/**
 * Follow a chat to a new session id in place (a `/branch` fork). Main owns the
 * driver table, so it renames there first; we mirror only once it confirms, and
 * return false when nothing moved so the caller leaves the UI where it is.
 */
export async function rekeyChat(
  oldChatId: string,
  newChatId: string,
): Promise<boolean> {
  const ok = await window.electronAPI.rekeyChat(oldChatId, newChatId);
  if (!ok) return false;
  const entry = started.get(oldChatId);
  started = new Map(started);
  started.delete(oldChatId);
  if (entry) started.set(newChatId, entry);
  emit();
  return true;
}

/** The engine driving `chatId`, or null when nothing is. */
export function engineForChat(chatId: string | null): ChatEngineId | null {
  return chatId ? (started.get(chatId)?.engine ?? null) : null;
}

/** Live "does this chat have a driver" flag. */
export function useChatStarted(chatId: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (chatId ? started.has(chatId) : false),
    () => false,
  );
}

/** Live engine binding for one chat. */
export function useChatEngineFor(chatId: string | null): ChatEngineId | null {
  return useSyncExternalStore(
    subscribe,
    () => engineForChat(chatId),
    () => null,
  );
}
