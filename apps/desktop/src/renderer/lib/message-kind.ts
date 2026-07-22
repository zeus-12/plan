import type { ConversationMessage } from "../../shared-types";

/**
 * What a transcript turn actually IS. Claude Code writes several kinds of
 * machinery into the `user` role — tool results, "!" bash turns, harness-
 * injected meta turns, background-task notifications — and only what the human
 * typed should read as a user message. This module is the single source of
 * that judgement so the transcript rows and the user-message minimap can never
 * disagree about it.
 */

// Claude Code records a pasted image as a standalone message whose text is just
// "[Image: source: <path>]". Render those straight from the file on disk via a
// file:// URL — no copy, no base64, no bytes through JS.
export function imageOnlyPaths(text: string): string[] | null {
  const re = /\[Image: source:\s*(.+?)\s*\]/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) paths.push(m[1]);
  if (paths.length === 0) return null;
  // Only treat the message as an image if that's ALL it contains.
  const remainder = text.replace(/\[Image: source:\s*(.+?)\s*\]/g, "").trim();
  return remainder.length === 0 ? paths : null;
}

/**
 * Claude Code records a "!" bash-mode turn as tagged text:
 *   <bash-input>cmd</bash-input>                                  the command
 *   <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>      its output
 * Detect those so we can render a terminal block instead of leaking raw tags.
 */
export function parseBashBlock(text: string): {
  input: string | null;
  stdout: string | null;
  stderr: string | null;
} | null {
  const t = text.trim();
  if (!/^<bash-(input|stdout|stderr)>/.test(t)) return null;
  const grab = (tag: string) => {
    const m = t.match(new RegExp(`<bash-${tag}>([\\s\\S]*?)</bash-${tag}>`));
    return m ? m[1] : null;
  };
  const input = grab("input");
  const stdout = grab("stdout");
  const stderr = grab("stderr");
  if (input === null && stdout === null && stderr === null) return null;
  return { input, stdout, stderr };
}

/**
 * Claude Code injects a background-task completion as a user turn whose text is
 * a raw `<task-notification>` block:
 *   <task-notification>
 *     <task-id>…</task-id><tool-use-id>…</tool-use-id>
 *     <output-file>…</output-file><status>completed</status>
 *     <summary>Background command "…" completed (exit code 0)</summary>
 *   </task-notification>
 * Parse those out (a turn may carry several) so we render a tidy status card
 * instead of leaking the angle-bracket soup. `remainder` is any surrounding
 * prose, rendered as normal markdown.
 */
export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  outputFile: string | null;
  status: string | null;
  summary: string | null;
}

export function parseTaskNotifications(
  text: string,
): { notifications: TaskNotification[]; remainder: string } | null {
  if (!text.includes("<task-notification>")) return null;
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  const notifications: TaskNotification[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const grab = (tag: string) => {
      const mm = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return mm ? mm[1].trim() : null;
    };
    notifications.push({
      taskId: grab("task-id"),
      toolUseId: grab("tool-use-id"),
      outputFile: grab("output-file"),
      status: grab("status"),
      summary: grab("summary"),
    });
  }
  if (notifications.length === 0) return null;
  const remainder = text.replace(re, "").trim();
  return { notifications, remainder };
}

/**
 * A "!" bash-mode turn (command or its output) — its parts are all bash-tagged
 * text. Rendered left-aligned and full-width like terminal output, not in the
 * right-hand user bubble.
 */
export function isBashMessage(m: ConversationMessage): boolean {
  return (
    m.parts.length > 0 &&
    m.parts.every((p) => p.kind === "text" && parseBashBlock(p.text) !== null)
  );
}

/**
 * A background-task notification turn (system-injected, not real user input) —
 * rendered full-width as a status card, not in the right-hand user bubble.
 */
export function isTaskNotificationMessage(m: ConversationMessage): boolean {
  return (
    m.parts.length > 0 &&
    m.parts.every(
      (p) => p.kind === "text" && parseTaskNotifications(p.text) !== null,
    )
  );
}

/**
 * A harness-injected turn (skill body, loop tick, context caveat) flagged by
 * metadata. Rendered full-width as a muted, collapsible system card, not in the
 * user bubble. Image-only meta turns are left alone — they render as images.
 */
export function isSystemMetaMessage(m: ConversationMessage): boolean {
  if (m.role !== "user") return false;
  if (m.isMeta !== true && m.promptSource !== "system") return false;
  return !m.parts.every(
    (p) => p.kind === "text" && imageOnlyPaths(p.text) !== null,
  );
}

export type MessageCategory = "user-real" | "tool" | "assistant";

// Cached per message object (messages are immutable — mergeSession swaps the
// object on any content change): the meta/notification checks above run regex
// over every part, and classify runs for every row on every streaming tick.
const categoryCache = new WeakMap<ConversationMessage, MessageCategory>();

export function classifyMessage(m: ConversationMessage): MessageCategory {
  let v = categoryCache.get(m);
  if (v === undefined) {
    if (m.role === "assistant") v = "assistant";
    else if (!m.parts.some((p) => p.kind !== "tool_result")) v = "tool";
    // Harness machinery rendered as tool-style rows (SystemMetaBlock /
    // TaskNotificationBlock) — categorized as "tool" so it doesn't count as a
    // turn change and pick up header spacing around it.
    else if (isSystemMetaMessage(m) || isTaskNotificationMessage(m)) v = "tool";
    else v = "user-real";
    categoryCache.set(m, v);
  }
  return v;
}

const userTurnCache = new WeakMap<ConversationMessage, boolean>();

/**
 * A turn the human actually typed — the thing that gets a right-hand bubble and
 * an entry in the user-message minimap. Everything the harness writes into the
 * `user` role (tool results, bash turns, meta turns, task notifications) is
 * excluded.
 */
export function isRealUserTurn(m: ConversationMessage): boolean {
  let v = userTurnCache.get(m);
  if (v === undefined) {
    v = !isBashMessage(m) && classifyMessage(m) === "user-real";
    userTurnCache.set(m, v);
  }
  return v;
}
