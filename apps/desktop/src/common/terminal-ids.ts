/**
 * The pty id scheme — the one module that knows how terminal ids are built and
 * read. Ids key main's pty table and the renderer's terminal view-state, and
 * both sides import from here (no Electron/Node imports, like ipc-contract).
 *
 *   chat:<encoded>:<sessionId>    a chat session's Claude instance
 *   term:<encoded>:<n>            a scratch shell (sidebar Terminals section)
 *   run:<encoded>:<entryId>       one Run-list command's pty
 *   build:<encoded>:<entryId>     one Build-list command's pty
 *   script:<encoded>:<entryId>    one Scripts-list command's pty
 *
 * `encoded` is Claude's cwd encoding ([a-zA-Z0-9-] only, so it never contains
 * ":"), and the suffixes are uuid/number-like — the segments are unambiguous.
 */

export function chatTerminalId(encoded: string, sessionId: string): string {
  return `chat:${encoded}:${sessionId}`;
}

/** Prefix of every chat pty in one project — for scoping startsWith checks. */
export function chatTerminalPrefix(encoded: string): string {
  return `chat:${encoded}:`;
}

export function shellTerminalId(encoded: string, n: number): string {
  return `term:${encoded}:${n}`;
}

export function shellTerminalPrefix(encoded: string): string {
  return `term:${encoded}:`;
}

/** The command lists that get their own terminal tab and pty namespace. */
export type CommandKind = "run" | "build" | "script";

/** Pty for one Run/Build/Scripts entry (per-worktree via `encoded`). */
export function commandTerminalId(
  kind: CommandKind,
  encoded: string,
  entryId: string,
): string {
  return `${kind}:${encoded}:${entryId}`;
}

/** Whether the id is a chat pty (a Claude session) — of ANY project. */
export function isChatTerminalId(id: string): boolean {
  return id.startsWith("chat:");
}

const CHAT_ID_RE = /^chat:(.+):([^:]+)$/;

/** Parse a chat pty id into its `{ encoded, sessionId }`, or null if not one. */
export function parseChatTerminalId(
  id: string,
): { encoded: string; sessionId: string } | null {
  const m = id.match(CHAT_ID_RE);
  return m ? { encoded: m[1], sessionId: m[2] } : null;
}

export type ParsedTerminalId =
  | { kind: "chat"; encoded: string; sessionId: string }
  | { kind: "shell"; encoded: string; n: string }
  | { kind: CommandKind; encoded: string; entryId: string }
  | { kind: "other" };

/** Classify any pty id (chat / scratch shell / run / build / script / other). */
export function parseTerminalId(id: string): ParsedTerminalId {
  const m = id.match(/^(chat|term|run|build|script):(.+):([^:]+)$/);
  if (!m) return { kind: "other" };
  const [, kind, encoded, suffix] = m;
  if (kind === "chat") return { kind: "chat", encoded, sessionId: suffix };
  if (kind === "term") return { kind: "shell", encoded, n: suffix };
  return { kind: kind as CommandKind, encoded, entryId: suffix };
}
