import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * Runs a shell snippet in a brand-new terminal for whatever project (or
 * worktree) the surrounding UI belongs to. The host decides how — the desktop
 * app confirms the exact text with the user before anything reaches a pty.
 *
 * Markdown renders in surfaces that have no ptys behind them (the web build,
 * any preview), so the sender is injected rather than imported: no provider
 * means no button, instead of a button that can't do anything.
 *
 * Resolves true only once the snippet has actually been handed to a pty — the
 * caller must not report success on a host that asked and was told no.
 */
export type TerminalSender = (command: string) => Promise<boolean>;

const SendToTerminalContext = createContext<TerminalSender | null>(null);

export function SendToTerminalProvider({
  send,
  children,
}: {
  send: TerminalSender;
  children: ReactNode;
}) {
  return (
    <SendToTerminalContext.Provider value={send}>
      {children}
    </SendToTerminalContext.Provider>
  );
}

export function useSendToTerminal(): TerminalSender | null {
  return useContext(SendToTerminalContext);
}
