import { createCliEngine } from "./claude-code/cli-engine";
import type { ChatEngine, ChatEngineListener } from "./chat-engine";
import {
  DEFAULT_CHAT_ENGINE,
  type ChatActivity,
  type ChatEngineDescriptor,
  type ChatEngineId,
  type ChatStatus,
  type StartChatOptions,
  type StartChatResult,
} from "../../chat-engines";

/**
 * The registry of chat engines — the one place that knows which engines exist
 * and which of them is driving a given chat.
 *
 * Routing is derived, not bookkept: an engine owns a chat exactly when it says
 * it does (`engine.has`). That's deliberate — a separate ownership map would be
 * a second copy of a fact the engines already hold, and the two would drift the
 * first time a session died in a way the map didn't hear about.
 *
 * Everything below is engine-agnostic. Registering a new engine (a Claude SDK
 * driver, a Codex one) is adding its id to CHAT_ENGINE_IDS and one line to
 * `ENGINES` — no call site in this file, in the IPC handlers, or in the
 * renderer needs to learn its name.
 */

const ENGINES: ChatEngine[] = [createCliEngine()];

const byId = new Map<ChatEngineId, ChatEngine>(
  ENGINES.map((e) => [e.descriptor.id, e]),
);

export function chatEngineDescriptors(): ChatEngineDescriptor[] {
  return ENGINES.map((e) => e.descriptor);
}

/** The engine currently driving `chatId`, or null when nothing is. */
function ownerOf(chatId: string): ChatEngine | null {
  for (const e of ENGINES) {
    if (e.has(chatId)) return e;
  }
  return null;
}

/**
 * Start (or reattach to) a chat. A chat that's already being driven keeps its
 * engine regardless of what was requested — switching engines mid-session would
 * mean two drivers on one transcript, so it requires stopping the chat first.
 */
export async function startChat(
  chatId: string,
  opts: StartChatOptions,
): Promise<StartChatResult> {
  const live = ownerOf(chatId);
  if (live) return live.start(chatId, opts);

  const engine = byId.get(opts.engine) ?? byId.get(DEFAULT_CHAT_ENGINE);
  if (!engine) {
    return {
      cwd: "",
      engine: opts.engine,
      error: `No chat engine registered for "${opts.engine}".`,
    };
  }
  return engine.start(chatId, opts);
}

export function sendToChat(
  chatId: string,
  text: string,
  imagePaths: string[],
): void {
  ownerOf(chatId)?.send(chatId, text, imagePaths);
}

export function sendKeysToChat(chatId: string, keys: string[]): void {
  const engine = ownerOf(chatId);
  // Keystrokes only mean something to an engine driving a real TUI; for any
  // other engine there is no screen to type at, so we drop them rather than
  // pretend they landed.
  if (engine?.descriptor.capabilities.keystrokes) engine.sendKeys(chatId, keys);
}

export async function chatStatus(chatId: string): Promise<ChatStatus> {
  const engine = ownerOf(chatId);
  if (!engine) return { running: false, agentLive: false, engine: null };
  return engine.status(chatId);
}

export function probeChatApproval(chatId: string): Promise<boolean> {
  const engine = ownerOf(chatId);
  return engine ? engine.probeApproval(chatId) : Promise.resolve(false);
}

export function busyChatIds(): string[] {
  return ENGINES.flatMap((e) => e.busyIds());
}

export async function approvalChatIds(): Promise<string[]> {
  const perEngine = await Promise.all(ENGINES.map((e) => e.approvalIds()));
  return perEngine.flat();
}

export function liveChatIds(): string[] {
  return ENGINES.flatMap((e) => e.liveIds());
}

export function stopChat(chatId: string): void {
  ownerOf(chatId)?.stop(chatId);
}

export function stopChatAndWait(
  chatId: string,
  timeoutMs?: number,
): Promise<void> {
  const engine = ownerOf(chatId);
  return engine ? engine.stopAndWait(chatId, timeoutMs) : Promise.resolve();
}

/**
 * Follow a chat to a new session id in place (a `/branch` fork). False when the
 * owning engine can't do it or there was nothing to move — the caller must not
 * repoint the UI on false.
 */
export function rekeyChat(oldChatId: string, newChatId: string): boolean {
  const engine = ownerOf(oldChatId);
  if (!engine?.descriptor.capabilities.branch) return false;
  return engine.rekey(oldChatId, newChatId);
}

export function stopAllChats(): void {
  for (const e of ENGINES) e.stopAll();
}

/** Subscribe to activity/exit from every registered engine at once. */
export function listenToChats(listener: ChatEngineListener): () => void {
  const offs = ENGINES.map((e) => e.listen(listener));
  return () => offs.forEach((off) => off());
}

export type { ChatActivity };
