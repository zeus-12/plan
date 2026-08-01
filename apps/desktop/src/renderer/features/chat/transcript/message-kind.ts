import type { ConversationMessage } from "@/common/shared-types";

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
 * A turn that carries nothing but attachments. It gets no bubble chrome and no
 * height clamp — thumbnails are already small, and a bubble around them would
 * draw a second border inside the image's own edge.
 */
export function isImageOnlyMessage(m: ConversationMessage): boolean {
  return (
    m.parts.length > 0 &&
    m.parts.every((p) => p.kind === "text" && imageOnlyPaths(p.text) !== null)
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
  return !isImageOnlyMessage(m);
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

/**
 * A turn the human submitted for Claude to answer. `promptSource` is only
 * written on those, which is what separates them from the rest of what shares
 * the `user` role once tool results are excluded: `[Request interrupted by
 * user]` markers, the image lines that trail a pasted screenshot, and prompts
 * Claude Code executes locally without a request (`/compact`) all lack it.
 * "system" is excluded too — a harness-injected turn isn't the user's.
 */
function isSubmittedPrompt(m: ConversationMessage): boolean {
  return m.promptSource === "typed" || m.promptSource === "queued";
}

/**
 * Prompts that sit in the transcript but never reached the model. Claude Code
 * appends a prompt to the JSONL the moment it's submitted, before the request
 * goes out; pressing Esc before the first token aborts the turn but leaves the
 * line there, and writes no `[Request interrupted by user]` marker (that one
 * only appears once a reply had started). So an abandoned prompt is
 * indistinguishable from a real turn until you walk the message tree and find
 * it never got an assistant descendant.
 *
 * "No reply" alone isn't enough, though — an unanswered prompt at the end of a
 * transcript may just be in flight, or queued behind a turn that's still
 * running. What proves abandonment is a LATER submission that did get answered:
 * Claude moved on, so this one is never getting a reply. Prompts after that
 * point stay unmarked, which is the honest answer for a session that ends right
 * after a submit — abandoned and about-to-be-answered look identical there.
 */
export function abortedPromptUuids(
  messages: ConversationMessage[],
): Set<string> {
  const aborted = new Set<string>();
  const parentOf = new Map<string, string | null>();
  for (const m of messages) parentOf.set(m.uuid, m.parentMessageUuid);

  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    let cur = m.parentMessageUuid;
    while (cur && !answered.has(cur)) {
      answered.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  // The newest submission that did get answered — only prompts before it are
  // provably abandoned. This also fails safe: a transcript whose parent links
  // didn't resolve has no answered submission at all, so it claims nothing
  // rather than dimming every turn in the session.
  let lastAnswered = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSubmittedPrompt(messages[i]) && answered.has(messages[i].uuid)) {
      lastAnswered = i;
      break;
    }
  }
  // Forward pass, so the `[Image: source: …]` line a pasted screenshot hangs off
  // its prompt is already reachable from an aborted parent by the time we get to
  // it — one submission dims as one unit instead of half of it. That inheritance
  // ignores the cutoff: the parent's verdict was already made under it, and a
  // trailing image line would otherwise sit undimmed beneath a dimmed prompt.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!isRealUserTurn(m) || answered.has(m.uuid)) continue;
    const partOfAbortedSubmission =
      m.parentMessageUuid !== null && aborted.has(m.parentMessageUuid);
    if (partOfAbortedSubmission || (i < lastAnswered && isSubmittedPrompt(m))) {
      aborted.add(m.uuid);
    }
  }
  return aborted;
}
