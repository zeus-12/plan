import type {
  ConversationMessage,
  MessagePart,
  ParsedSession,
} from "@/common/shared-types";

/**
 * Re-parsing a session JSONL creates all-new message objects every time, which
 * defeats row memoization — every watcher tick would re-render (and re-parse
 * markdown for) the entire transcript. This merge keeps the OLD object for any
 * message whose content is unchanged, so React only re-renders what actually
 * changed. Returns `prev` itself when nothing changed at all.
 *
 * Equality is exact (string compares, not heuristics). The JSONL is an
 * append-only log, so a tool_use with the same id is the same call.
 */
export function mergeSession(
  prev: ParsedSession | null,
  next: ParsedSession | null,
): ParsedSession | null {
  if (!next) return null;
  if (!prev) return next;

  let unchanged =
    prev.messages.length === next.messages.length &&
    prev.meta.title === next.meta.title &&
    prev.meta.messageCount === next.meta.messageCount &&
    prev.meta.updatedAt === next.meta.updatedAt;

  const merged = next.messages.map((m, i) => {
    const old = prev.messages[i];
    if (old && sameMessage(old, m)) return old;
    unchanged = false;
    return m;
  });

  if (unchanged) return prev;
  return { ...next, messages: merged };
}

function sameMessage(a: ConversationMessage, b: ConversationMessage): boolean {
  // Incremental reads (transcript-sync) reuse prefix objects as-is.
  if (a === b) return true;
  if (
    a.uuid !== b.uuid ||
    a.role !== b.role ||
    a.parts.length !== b.parts.length
  ) {
    return false;
  }
  for (let i = 0; i < a.parts.length; i++) {
    if (!samePart(a.parts[i], b.parts[i])) return false;
  }
  return true;
}

function samePart(a: MessagePart, b: MessagePart): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "text":
    case "thinking":
      return a.text === (b as { text: string }).text;
    case "tool_use": {
      const tb = b as Extract<MessagePart, { kind: "tool_use" }>;
      // Same id ⇒ same call, but input is NOT immutable while streaming: Claude
      // writes a tool_use line with an empty/partial `input`, then rewrites the
      // same line (same id) once the full input is assembled. Comparing only
      // id+tool would hold the stale empty version forever — e.g. an
      // ExitPlanMode card stuck blank because its `plan` arrived in the rewrite.
      return (
        a.id === tb.id && a.tool === tb.tool && sameInput(a.input, tb.input)
      );
    }
    case "tool_result": {
      const tb = b as Extract<MessagePart, { kind: "tool_result" }>;
      return (
        a.toolUseId === tb.toolUseId &&
        a.output === tb.output &&
        a.isError === tb.isError
      );
    }
  }
}

/**
 * Structural equality for a tool_use's `input`. Reads of the same JSONL produce
 * stable key order, so a string compare is exact; steady-state inputs serialize
 * identically and keep the old object (no extra re-render).
 */
function sameInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
