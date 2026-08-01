import type {
  ChatActivity,
  ChatEngineDescriptor,
  ChatEngineId,
  ChatStatus,
  StartChatOptions,
  StartChatResult,
} from "@/common/chat-engines";

/**
 * The chat-engine SPI — what main needs from anything that can drive a Claude
 * session. One implementation per engine (see cli-engine.ts); the registry
 * holds them and routes each chat id to the engine that owns it.
 *
 * Deliberately plain values and promises rather than a class hierarchy or a
 * service container: an engine is a small bag of closures over its own state,
 * and two engines share nothing. Adding one is writing this interface and
 * registering it — no other file has to learn its name.
 *
 * The rules an implementation must hold to:
 *
 *  - **Report only observed facts.** `busy` / `awaitingApproval` / `agentLive`
 *    must come from something the engine actually saw (a rendered screen, a
 *    protocol message, a live process), never from "we just sent a message so
 *    it's probably working". When the truth isn't known, report the neutral
 *    state, not the optimistic one.
 *  - **`start` is idempotent.** Called again for a chat that's already driven,
 *    it reattaches and returns the live engine — it never starts a second one.
 *  - **Emit on change only.** `onActivity` fires when the pair actually flips,
 *    so idle chats cost nothing.
 *  - **`onExit` is the single teardown signal.** Whatever ends a chat (the user
 *    quitting it, the process dying, a kill from elsewhere), it ends with one
 *    `onExit` so the registry and the renderer converge.
 */
export interface ChatEngineListener {
  onActivity: (chatId: string, activity: ChatActivity) => void;
  onExit: (chatId: string) => void;
}

export interface ChatEngine {
  readonly descriptor: ChatEngineDescriptor;

  /** Subscribe to this engine's activity/exit events. */
  listen(listener: ChatEngineListener): () => void;

  /**
   * Start driving `chatId`, or reattach if it's already live. Resolves once the
   * chat can take a message.
   */
  start(chatId: string, opts: StartChatOptions): Promise<StartChatResult>;

  /** Deliver a user message (with any attached image paths) and submit it. */
  send(chatId: string, text: string, imagePaths: string[]): void;

  /**
   * Answer an on-screen TUI selector with raw keystrokes. Only meaningful for
   * engines with `capabilities.keystrokes`; others no-op.
   */
  sendKeys(chatId: string, keys: string[]): void;

  status(chatId: string): Promise<ChatStatus>;

  /**
   * Re-read RIGHT NOW whether this chat is parked waiting on the user, rather
   * than trusting a pushed snapshot. Callers that are about to type into a
   * session (the auto-continue watcher) use this so they never answer a menu by
   * accident, and treat a thrown/false-y answer as "don't send".
   */
  probeApproval(chatId: string): Promise<boolean>;

  /** Chats this engine is driving that are mid-turn. */
  busyIds(): string[];

  /** Chats this engine is driving that are parked waiting on the user. */
  approvalIds(): Promise<string[]>;

  /** Every chat this engine currently drives. */
  liveIds(): string[];

  has(chatId: string): boolean;

  /** End the chat. Fires `onExit`. */
  stop(chatId: string): void;

  /**
   * End the chat and resolve only once it's really gone (or `timeoutMs`
   * elapses). Needed before moving a transcript: a live Claude writing to a
   * path derived from its cwd will re-create it at the old location if it
   * outlives the move.
   */
  stopAndWait(chatId: string, timeoutMs?: number): Promise<void>;

  /**
   * Follow a chat whose session id changed under it (a `/branch` fork keeps the
   * same driver but starts writing a new transcript). Returns false when there
   * is nothing to move or the destination is taken — the caller must not
   * repoint the UI then. Only for engines with `capabilities.branch`.
   */
  rekey(oldChatId: string, newChatId: string): boolean;

  /** Tear every chat down (app quit). */
  stopAll(): void;
}

export type { ChatEngineId, ChatEngineDescriptor };
