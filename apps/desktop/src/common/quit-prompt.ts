/** Copy for the quit confirmation, shared so the in-app modal and main's
 *  native fallback dialog can't drift apart. */

/** "ack" = the prompt is on screen, so main should wait for the decision. */
export type QuitAnswer = "ack" | "quit" | "cancel";

export interface RunningCounts {
  chats: number;
  terminals: number;
}

export const QUIT_PROMPT_TITLE = "Quit Plan?";
export const QUIT_PROMPT_CONFIRM = "Quit";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Undefined when nothing is running — the prompt then stands alone as a
 *  guard against a mistyped ⌘Q, with nothing to warn about. */
export function quitPromptDetail(counts: RunningCounts): string | undefined {
  const parts: string[] = [];
  if (counts.chats > 0) parts.push(plural(counts.chats, "chat", "chats"));
  if (counts.terminals > 0)
    parts.push(plural(counts.terminals, "terminal", "terminals"));
  if (parts.length === 0) return undefined;
  const total = counts.chats + counts.terminals;
  return `${parts.join(" and ")} ${total === 1 ? "is" : "are"} still running. Quitting ends ${total === 1 ? "it" : "them"}.`;
}
