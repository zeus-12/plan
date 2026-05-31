import { readFile } from "fs/promises";
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
