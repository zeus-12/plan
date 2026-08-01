import {
  addTerminalListener,
  isTerminalRunning,
  killTerminal,
  killTerminalAndWait,
  openTerminal,
  rekeyTerminal,
  sendKeys as writeKeys,
  terminalIds,
} from "@/main/terminal/terminal";
import { isChatTerminalId } from "@/common/terminal-ids";
import { claudeStartCommand } from "./cli-command";
import { submitMessage } from "./tui-input";
import {
  agentLiveIn,
  awaitingApprovalIds,
  createActivityTracker,
  isAwaitingApproval,
  isBusy,
} from "./tui-activity";
import type { ChatStatus, StartChatResult } from "@/common/chat-engines";
import type { ChatEngine, ChatEngineListener } from "../chat-engine";

/**
 * The Claude Code CLI engine — a chat is the interactive `claude` TUI running
 * in a pty (`chat:<enc>:<sid>`, one per session).
 *
 * This file is the composition: it wires the generic pty service to the three
 * pieces that know what Claude is — how to invoke the binary (cli-command), how
 * to get a message into its input box (tui-input), and how to read its rendered
 * screen (tui-activity, over tui-screen).
 *
 * The pty table is this engine's session state: a chat is one it drives exactly
 * when a pty exists under that id. There is no second registry to fall out of
 * sync with.
 */

const ENGINE_ID = "claude-cli" as const;

export function createCliEngine(): ChatEngine {
  const listeners = new Set<ChatEngineListener>();

  const tracker = createActivityTracker((chatId, activity) => {
    for (const l of listeners) l.onActivity(chatId, activity);
  });

  // The pty layer reports on every terminal — scratch shells, Run/Build
  // commands, chats. Only the chat ones are this engine's business.
  addTerminalListener({
    onData: (chunk) => {
      if (isChatTerminalId(chunk.id)) tracker.noteOutput(chunk.id);
    },
    onExit: (id) => {
      if (!isChatTerminalId(id)) return;
      tracker.forget(id);
      for (const l of listeners) l.onExit(id);
    },
  });

  const chatIds = () => terminalIds().filter(isChatTerminalId);

  return {
    descriptor: {
      id: ENGINE_ID,
      label: "Claude Code (terminal)",
      description:
        "Runs the interactive Claude Code TUI in a real terminal. Full slash-command support, and the terminal itself is there to drop into.",
      capabilities: {
        terminalPane: true,
        keystrokes: true,
        branch: true,
      },
    },

    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start(chatId, opts): Promise<StartChatResult> {
      // openTerminal reuses a live pty and ignores the command on reuse, so a
      // reconnect reattaches instead of starting a second Claude.
      const { cwd, error } = await openTerminal(
        chatId,
        opts.encoded,
        undefined,
        undefined,
        claudeStartCommand(opts),
      );
      return { cwd, engine: ENGINE_ID, ...(error ? { error } : {}) };
    },

    send(chatId, text, imagePaths) {
      submitMessage(chatId, text, imagePaths);
    },

    sendKeys(chatId, keys) {
      writeKeys(chatId, keys);
    },

    async status(chatId): Promise<ChatStatus> {
      if (!isTerminalRunning(chatId))
        return { running: false, agentLive: false, engine: null };
      return {
        running: true,
        agentLive: await agentLiveIn(chatId),
        engine: ENGINE_ID,
      };
    },

    probeApproval(chatId) {
      return isAwaitingApproval(chatId);
    },

    busyIds() {
      return chatIds().filter(isBusy);
    },

    approvalIds() {
      return awaitingApprovalIds(chatIds());
    },

    liveIds() {
      return chatIds();
    },

    has(chatId) {
      return isTerminalRunning(chatId);
    },

    stop(chatId) {
      killTerminal(chatId);
    },

    stopAndWait(chatId, timeoutMs) {
      return killTerminalAndWait(chatId, timeoutMs);
    },

    rekey(oldChatId, newChatId) {
      const ok = rekeyTerminal(oldChatId, newChatId);
      if (ok) tracker.rename(oldChatId, newChatId);
      return ok;
    },

    stopAll() {
      for (const id of chatIds()) killTerminal(id);
    },
  };
}
