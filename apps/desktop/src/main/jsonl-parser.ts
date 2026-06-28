import { readFile, open, stat } from "fs/promises";
import { StringDecoder } from "string_decoder";
import type {
  MessagePart,
  ConversationMessage,
  ParsedSession,
} from "../shared-types";

export type { MessagePart, ConversationMessage, ParsedSession };

type Json = unknown;

interface RawLine {
  type?: string;
  [k: string]: Json;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parseAssistantParts(content: unknown): MessagePart[] {
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    switch (c.type) {
      case "text":
        if (typeof c.text === "string" && c.text.length > 0) {
          parts.push({ kind: "text", text: c.text });
        }
        break;
      case "thinking":
        if (typeof c.thinking === "string" && c.thinking.length > 0) {
          parts.push({ kind: "thinking", text: c.thinking });
        }
        break;
      case "tool_use":
        parts.push({
          kind: "tool_use",
          id: typeof c.id === "string" ? c.id : "",
          tool: typeof c.name === "string" ? c.name : "?",
          input: c.input ?? null,
        });
        break;
    }
  }
  return parts;
}

function parseUserParts(content: unknown): MessagePart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: MessagePart[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item.length > 0) parts.push({ kind: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    switch (c.type) {
      case "text":
        if (typeof c.text === "string" && c.text.length > 0) {
          parts.push({ kind: "text", text: c.text });
        }
        break;
      case "tool_result": {
        const toolUseId = typeof c.tool_use_id === "string" ? c.tool_use_id : "";
        const output = asString(c.content);
        parts.push({
          kind: "tool_result",
          toolUseId,
          output,
          isError: c.is_error === true,
        });
        break;
      }
    }
  }
  return parts;
}

export function parseSessionJsonl(raw: string, filePath: string): ParsedSession {
  const lines = raw.split("\n");
  const messages: ConversationMessage[] = [];
  let sessionId = "";
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let title: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: RawLine;
    try {
      obj = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }

    if (typeof obj.sessionId === "string" && !sessionId) sessionId = obj.sessionId;
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string") gitBranch = obj.gitBranch;
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
      title = obj.aiTitle;
    }
    if (typeof obj.timestamp === "string") {
      if (!startedAt) startedAt = obj.timestamp;
      updatedAt = obj.timestamp;
    }

    if (obj.type === "user" || obj.type === "assistant") {
      const message = (obj as { message?: { content?: unknown } }).message;
      const content = message?.content;
      const parts =
        obj.type === "assistant"
          ? parseAssistantParts(content)
          : parseUserParts(content);
      if (parts.length === 0) continue;

      messages.push({
        uuid: typeof obj.uuid === "string" ? obj.uuid : "",
        parentUuid:
          typeof obj.parentUuid === "string" ? obj.parentUuid : null,
        role: obj.type,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
        parts,
      });
    }
  }

  return {
    meta: {
      sessionId,
      filePath,
      cwd,
      gitBranch,
      title,
      startedAt,
      updatedAt,
      messageCount: messages.length,
    },
    messages,
  };
}

export async function readSessionFile(filePath: string): Promise<ParsedSession> {
  const raw = await readFile(filePath, "utf-8");
  return parseSessionJsonl(raw, filePath);
}

// ── Incremental session metadata (append-only fast path) ───────────────────
// The session list only needs title / messageCount / updatedAt, but the file
// of the actively-streaming session changes mtime on every write, so a naive
// "re-parse on mtime change" re-reads and fully re-parses the whole growing
// transcript several times a second. JSONL is append-only, so instead we keep
// per-file running state and parse only the bytes appended since last time.

export interface SessionMetaLite {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

interface MetaState extends SessionMetaLite {
  /** Bytes consumed so far — where the next incremental read starts. */
  bytesSeen: number;
  /** Decoder carries any incomplete trailing UTF-8 bytes across reads. */
  decoder: StringDecoder;
  /** The trailing partial line (no newline yet) carried to the next read. */
  leftover: string;
}

const metaStates = new Map<string, MetaState>();

function freshState(): MetaState {
  return {
    sessionId: "",
    cwd: null,
    gitBranch: null,
    title: null,
    startedAt: null,
    updatedAt: null,
    messageCount: 0,
    bytesSeen: 0,
    decoder: new StringDecoder("utf8"),
    leftover: "",
  };
}

function applyMetaLine(state: MetaState, line: string): void {
  if (!line.trim()) return;
  let obj: RawLine;
  try {
    obj = JSON.parse(line) as RawLine;
  } catch {
    return;
  }
  if (typeof obj.sessionId === "string" && !state.sessionId)
    state.sessionId = obj.sessionId;
  if (typeof obj.cwd === "string" && !state.cwd) state.cwd = obj.cwd;
  if (typeof obj.gitBranch === "string") state.gitBranch = obj.gitBranch;
  if (obj.type === "ai-title" && typeof obj.aiTitle === "string")
    state.title = obj.aiTitle;
  if (typeof obj.timestamp === "string") {
    if (!state.startedAt) state.startedAt = obj.timestamp;
    state.updatedAt = obj.timestamp;
  }
  if (obj.type === "user" || obj.type === "assistant") {
    const content = (obj as { message?: { content?: unknown } }).message
      ?.content;
    const parts =
      obj.type === "assistant"
        ? parseAssistantParts(content)
        : parseUserParts(content);
    // Mirror parseSessionJsonl: a message with no renderable parts doesn't count.
    if (parts.length > 0) state.messageCount += 1;
  }
}

// Dedup concurrent reads of the same file so overlapping listSessions calls
// can't interleave and corrupt a file's running state (bytesSeen / leftover).
const metaInflight = new Map<string, Promise<SessionMetaLite>>();

/**
 * Title / messageCount / updatedAt for a session file, parsing only the bytes
 * appended since the last call. Falls back to a full re-read if the file shrank
 * (rewritten / truncated). Cheap enough to call on every watcher tick.
 */
export function readSessionMeta(filePath: string): Promise<SessionMetaLite> {
  const existing = metaInflight.get(filePath);
  if (existing) return existing;
  const p = readSessionMetaInner(filePath).finally(() =>
    metaInflight.delete(filePath)
  );
  metaInflight.set(filePath, p);
  return p;
}

async function readSessionMetaInner(
  filePath: string
): Promise<SessionMetaLite> {
  const { size } = await stat(filePath);
  let state = metaStates.get(filePath);
  // File shrank → it was rewritten, not appended; our running state is stale.
  if (state && size < state.bytesSeen) state = undefined;
  if (!state) {
    state = freshState();
    metaStates.set(filePath, state);
  }
  if (size > state.bytesSeen) {
    const fh = await open(filePath, "r");
    try {
      const len = size - state.bytesSeen;
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, state.bytesSeen);
      state.bytesSeen = size;
      const chunk = state.leftover + state.decoder.write(buf);
      const lines = chunk.split("\n");
      // The last element is either "" (file ended on a newline) or a partial
      // line still being written — carry it forward, uncounted, until complete.
      state.leftover = lines.pop() ?? "";
      for (const line of lines) applyMetaLine(state, line);
    } finally {
      await fh.close();
    }
  }
  return {
    sessionId: state.sessionId,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    title: state.title,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    messageCount: state.messageCount,
  };
}
