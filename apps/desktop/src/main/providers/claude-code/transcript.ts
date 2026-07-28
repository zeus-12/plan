import { readFile, open, stat } from "fs/promises";
import { StringDecoder } from "string_decoder";
import type {
  MessagePart,
  ConversationMessage,
  ParsedSession,
  SessionDelta,
  SessionDeltaClient,
} from "../../../shared-types";

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
        const toolUseId =
          typeof c.tool_use_id === "string" ? c.tool_use_id : "";
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

/** Session-level fields folded line by line. First sessionId/cwd/startedAt win;
 *  gitBranch/title/updatedAt track the latest line that carries them. */
interface MetaFields {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

function freshMetaFields(): MetaFields {
  return {
    sessionId: "",
    cwd: null,
    gitBranch: null,
    title: null,
    startedAt: null,
    updatedAt: null,
  };
}

function applyMetaFields(fields: MetaFields, obj: RawLine): void {
  if (typeof obj.sessionId === "string" && !fields.sessionId)
    fields.sessionId = obj.sessionId;
  if (typeof obj.cwd === "string" && !fields.cwd) fields.cwd = obj.cwd;
  if (typeof obj.gitBranch === "string") fields.gitBranch = obj.gitBranch;
  if (obj.type === "ai-title" && typeof obj.aiTitle === "string")
    fields.title = obj.aiTitle;
  if (typeof obj.timestamp === "string") {
    if (!fields.startedAt) fields.startedAt = obj.timestamp;
    fields.updatedAt = obj.timestamp;
  }
}

/** Parse one message line's renderable parts, or null for non-message /
 *  no-renderable-parts lines (which don't count toward the transcript). */
function parseMessageLine(obj: RawLine): ConversationMessage | null {
  if (obj.type !== "user" && obj.type !== "assistant") return null;
  const message = (obj as { message?: { content?: unknown } }).message;
  const content = message?.content;
  const parts =
    obj.type === "assistant"
      ? parseAssistantParts(content)
      : parseUserParts(content);
  if (parts.length === 0) return null;

  const promptSource =
    obj.promptSource === "system" || obj.promptSource === "typed"
      ? obj.promptSource
      : undefined;
  // A failed request is still written as an assistant turn; `isApiErrorMessage`
  // is what distinguishes it from a real reply. Carry Claude's own `error` /
  // `apiErrorStatus` through so consumers classify from these fields instead of
  // pattern-matching the printed text.
  const apiError =
    obj.isApiErrorMessage === true
      ? {
          kind: typeof obj.error === "string" ? obj.error : "unknown",
          ...(typeof obj.apiErrorStatus === "number"
            ? { status: obj.apiErrorStatus }
            : {}),
        }
      : undefined;
  return {
    uuid: typeof obj.uuid === "string" ? obj.uuid : "",
    parentUuid: typeof obj.parentUuid === "string" ? obj.parentUuid : null,
    role: obj.type,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
    parts,
    ...(obj.isMeta === true ? { isMeta: true } : {}),
    ...(promptSource ? { promptSource } : {}),
    ...(apiError ? { apiError } : {}),
  };
}

/** Full transcript fold: meta fields plus every parsed message, in file order.
 *  Feeding it lines one at a time yields exactly what parsing the whole file at
 *  once yields — the property the incremental transcript reader relies on. */
interface SessionFold {
  fields: MetaFields;
  messages: ConversationMessage[];
}

function freshSessionFold(): SessionFold {
  return { fields: freshMetaFields(), messages: [] };
}

function applySessionLine(fold: SessionFold, line: string): void {
  if (!line.trim()) return;
  let obj: RawLine;
  try {
    obj = JSON.parse(line) as RawLine;
  } catch {
    return;
  }
  applyMetaFields(fold.fields, obj);
  const message = parseMessageLine(obj);
  if (message) fold.messages.push(message);
}

function packageSession(fold: SessionFold, filePath: string): ParsedSession {
  return {
    meta: {
      ...fold.fields,
      filePath,
      messageCount: fold.messages.length,
    },
    messages: fold.messages,
  };
}

export function parseSessionJsonl(
  raw: string,
  filePath: string,
): ParsedSession {
  const fold = freshSessionFold();
  for (const line of raw.split("\n")) applySessionLine(fold, line);
  return packageSession(fold, filePath);
}

export async function readSessionFile(
  filePath: string,
): Promise<ParsedSession> {
  const raw = await readFile(filePath, "utf-8");
  return parseSessionJsonl(raw, filePath);
}

// ── Incremental follow (append-only fast path) ──────────────────────────────
// The file of an actively-streaming session changes mtime on every write, so a
// naive "re-parse on mtime change" re-reads and fully re-parses the whole
// growing transcript several times a second (this froze the renderer once via
// the session list, and again via open chat tabs). JSONL is append-only in
// steady state, so instead we keep a per-file byte cursor and parse only what
// was appended since last time.
//
// "Steady state" carries two documented exceptions, both of which REWRITE
// bytes we already consumed: a streaming tool_use line is truncated and
// rewritten once its full input is assembled (see mergeSession's sameInput
// note), and a resumed session can rewrite the whole file. A shrink check
// alone misses the rewrite that ends up LARGER, so the follower re-reads the
// last consumed bytes each time and compares: any mismatch restarts the follow
// from byte 0. Correctness never depends on append-only holding — a rewrite
// just costs one full re-parse.

/** How many trailing consumed bytes are kept and re-verified per read. Tail
 *  rewrites replace the last line, so the window only needs to cover it. */
const TAIL_BYTES = 4096;

interface JsonlFollow {
  /** Bytes consumed so far — where the next incremental read starts. */
  bytesSeen: number;
  /** Decoder carries any incomplete trailing UTF-8 bytes across reads. */
  decoder: StringDecoder;
  /** The trailing partial line (no newline yet) carried to the next read. */
  leftover: string;
  /** The last ≤TAIL_BYTES raw bytes ending at `bytesSeen`, compared against
   *  the file on the next read to detect rewrites of consumed bytes. */
  tail: Buffer;
}

function freshFollow(): JsonlFollow {
  return {
    bytesSeen: 0,
    decoder: new StringDecoder("utf8"),
    leftover: "",
    tail: Buffer.alloc(0),
  };
}

/** `fh.read` may return short for a regular file in theory; loop to be exact.
 *  Returns false if the file ended before `len` bytes (treated as a rewrite). */
async function readExact(
  fh: Awaited<ReturnType<typeof open>>,
  buf: Buffer,
  len: number,
  position: number,
): Promise<boolean> {
  let done = 0;
  while (done < len) {
    const { bytesRead } = await fh.read(buf, done, len - done, position + done);
    if (bytesRead <= 0) return false;
    done += bytesRead;
  }
  return true;
}

/**
 * The complete lines appended to `filePath` since the last call with this
 * state. `reset: true` means previously-consumed bytes changed (the file was
 * rewritten or truncated): the follow restarted from byte 0 and `lines` covers
 * the whole file, so the caller must rebuild its fold state before applying.
 */
async function followJsonl(
  filePath: string,
  follow: JsonlFollow,
): Promise<{ lines: string[]; reset: boolean }> {
  const { size } = await stat(filePath);
  const fh = await open(filePath, "r");
  try {
    let reset = false;
    if (size < follow.bytesSeen) {
      reset = true;
    } else if (follow.tail.length > 0) {
      const win = Buffer.allocUnsafe(follow.tail.length);
      const ok = await readExact(
        fh,
        win,
        win.length,
        follow.bytesSeen - follow.tail.length,
      );
      if (!ok || !win.equals(follow.tail)) reset = true;
    }
    if (reset) Object.assign(follow, freshFollow());
    if (size === follow.bytesSeen) return { lines: [], reset };

    const len = size - follow.bytesSeen;
    const buf = Buffer.allocUnsafe(len);
    if (!(await readExact(fh, buf, len, follow.bytesSeen))) {
      // File shrank under us mid-read. Restart cleanly next call — and throw
      // rather than surface a partial fold (callers treat errors as "keep
      // whatever you showed before", which is truthful; an empty fold isn't).
      Object.assign(follow, freshFollow());
      throw new Error(`file changed mid-read: ${filePath}`);
    }
    // Copy (not subarray) so the tail doesn't pin a multi-MB read buffer.
    const joined = follow.tail.length ? Buffer.concat([follow.tail, buf]) : buf;
    follow.tail = Buffer.from(
      joined.subarray(Math.max(0, joined.length - TAIL_BYTES)),
    );
    follow.bytesSeen = size;
    const chunk = follow.leftover + follow.decoder.write(buf);
    const lines = chunk.split("\n");
    // The last element is either "" (file ended on a newline) or a partial
    // line still being written — carry it forward, unparsed, until complete.
    follow.leftover = lines.pop() ?? "";
    return { lines, reset };
  } finally {
    await fh.close();
  }
}

// ── Incremental session metadata ────────────────────────────────────────────

export interface SessionMetaLite extends MetaFields {
  messageCount: number;
}

interface MetaState {
  follow: JsonlFollow;
  fields: MetaFields;
  messageCount: number;
}

const metaStates = new Map<string, MetaState>();

function applyMetaLine(state: MetaState, line: string): void {
  if (!line.trim()) return;
  let obj: RawLine;
  try {
    obj = JSON.parse(line) as RawLine;
  } catch {
    return;
  }
  applyMetaFields(state.fields, obj);
  // Mirror parseSessionJsonl: a message with no renderable parts doesn't count.
  // Parsed and dropped (rather than kept like the transcript fold) so the meta
  // path never retains message bodies for every session in every project.
  if (parseMessageLine(obj)) state.messageCount += 1;
}

// Dedup concurrent reads of the same file so overlapping listSessions calls
// can't interleave and corrupt a file's running state (bytesSeen / leftover).
const metaInflight = new Map<string, Promise<SessionMetaLite>>();

/**
 * Title / messageCount / updatedAt for a session file, parsing only the bytes
 * appended since the last call (full re-fold when the follower detects a
 * rewrite). Cheap enough to call on every watcher tick.
 */
export function readSessionMeta(filePath: string): Promise<SessionMetaLite> {
  const existing = metaInflight.get(filePath);
  if (existing) return existing;
  const p = readSessionMetaInner(filePath).finally(() =>
    metaInflight.delete(filePath),
  );
  metaInflight.set(filePath, p);
  return p;
}

async function readSessionMetaInner(
  filePath: string,
): Promise<SessionMetaLite> {
  let state = metaStates.get(filePath);
  if (!state) {
    state = {
      follow: freshFollow(),
      fields: freshMetaFields(),
      messageCount: 0,
    };
    metaStates.set(filePath, state);
  }
  const { lines, reset } = await followJsonl(filePath, state.follow);
  if (reset) {
    state.fields = freshMetaFields();
    state.messageCount = 0;
  }
  for (const line of lines) applyMetaLine(state, line);
  return { ...state.fields, messageCount: state.messageCount };
}

// ── Incremental transcript (open chat tabs) ─────────────────────────────────
// Same follower, but the fold keeps the parsed messages so the renderer can be
// answered with just the messages past its cursor instead of a full re-read +
// full re-parse + multi-MB IPC payload on every watcher tick of a streaming
// session.

interface TranscriptState {
  follow: JsonlFollow;
  fold: SessionFold;
  /** Identity of this fold instance. Bumped whenever the fold restarts (first
   *  read, rewrite reset), invalidating every client cursor issued against the
   *  previous fold. */
  gen: number;
}

let nextGen = 1;

/** LRU by re-insertion. A fold retains the whole parsed transcript, so the
 *  count is bounded; eviction only costs the next reader a full re-parse. */
const MAX_FOLLOWED_TRANSCRIPTS = 8;
const transcriptStates = new Map<string, TranscriptState>();

const transcriptInflight = new Map<string, Promise<TranscriptState>>();

function advanceTranscript(filePath: string): Promise<TranscriptState> {
  const existing = transcriptInflight.get(filePath);
  if (existing) return existing;
  const p = advanceTranscriptInner(filePath).finally(() =>
    transcriptInflight.delete(filePath),
  );
  transcriptInflight.set(filePath, p);
  return p;
}

async function advanceTranscriptInner(
  filePath: string,
): Promise<TranscriptState> {
  let state = transcriptStates.get(filePath);
  if (!state) {
    state = { follow: freshFollow(), fold: freshSessionFold(), gen: nextGen++ };
  }
  const { lines, reset } = await followJsonl(filePath, state.follow);
  if (reset) {
    state.fold = freshSessionFold();
    state.gen = nextGen++;
  }
  for (const line of lines) applySessionLine(state.fold, line);
  transcriptStates.delete(filePath);
  transcriptStates.set(filePath, state);
  for (const key of transcriptStates.keys()) {
    if (transcriptStates.size <= MAX_FOLLOWED_TRANSCRIPTS) break;
    transcriptStates.delete(key);
  }
  return state;
}

/**
 * Read a session transcript incrementally. Callers pass the `gen` and message
 * count from their previous read; when they match the live fold, the response
 * carries only the new messages. Any mismatch (first read, fold evicted, file
 * rewritten) falls back to a full restatement — the cursor can never produce a
 * transcript that differs from a from-scratch parse.
 */
export async function readSessionDelta(
  filePath: string,
  client?: SessionDeltaClient,
): Promise<SessionDelta> {
  const state = await advanceTranscript(filePath);
  const { messages } = state.fold;
  const meta = packageSession(state.fold, filePath).meta;
  const append =
    client !== undefined &&
    client.gen === state.gen &&
    client.have <= messages.length;
  return {
    gen: state.gen,
    mode: append ? "append" : "full",
    total: messages.length,
    meta,
    // Sliced copy either way: the fold array keeps growing after this handler
    // resolves, and the IPC layer serializes asynchronously.
    messages: append ? messages.slice(client.have) : messages.slice(),
  };
}
