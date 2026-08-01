import { useMemo, useSyncExternalStore } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { generateMessage } from "@plan/shared/lib/store";

/**
 * In-progress comments across every surface (diffs, chat, file viewer, PRs),
 * keyed by project `encoded`. This module owns the whole domain: adding,
 * editing and removing comments, id minting, and aggregation into the message
 * they ride out on — consumers never touch raw state. The buffer empties when
 * that message is sent, or when the user clears it.
 *
 * Lives at module scope so it survives `ProjectWorkspace` remounts — the
 * workspace is keyed by `encoded` in App, so without this the comments would
 * be lost every time the user switches projects in the first sidebar.
 *
 * Persisted to localStorage so the comments also survive a renderer refresh
 * and a full app quit & relaunch — a comment you've drafted but not yet sent
 * to the chat is real work and must not vanish when the window reloads.
 */

/**
 * Where a comment was made, recorded when it's added so the comment list can
 * reopen it. The surface states this itself — the slice keys can't be parsed
 * back into a tab (diff comments key on the path alone, with no repo or staged
 * flag, and plan-card writes version-pair keys into that same slice).
 * Absent on comments drafted before this was recorded; those simply don't jump.
 */
export type CommentTarget =
  | { kind: "file"; path: string }
  | { kind: "diff"; subPath: string; path: string; staged: boolean }
  | { kind: "pr"; subPath: string; number: number; file?: string }
  | { kind: "chat"; sessionId: string };

/** An annotation as this store keeps it: the shared shape plus its origin. */
export interface StoredAnnotation extends Annotation {
  target?: CommentTarget;
}

/** One endpoint of a chat selection: which message, which part of that turn, and
 *  the char offset into that part's annotatable text (see message-list's
 *  `annoTextWalker`). */
export interface ChatSpan {
  messageUuid: string;
  partIndex: number;
  offset: number;
}

/** A chat comment anchored to a document-order span from `start` to `end`, which
 *  may cross several parts AND several message rows (prose + the tool rows and
 *  turns between them). */
export interface ChatAnnotation {
  id: string;
  start: ChatSpan;
  end: ChatSpan;
  selectedText: string;
  comment: string;
  target?: CommentTarget;
}

/** Surface-specific anchor for a chat comment: a document-order span from `start`
 *  to `end`, which may cross parts and message rows. */
export interface ChatAnchor {
  start: ChatSpan;
  end: ChatSpan;
}

/** A comment as the caller describes it — the store mints the id. */
export type NewAnnotation = Omit<StoredAnnotation, "id">;

/** The raw selection facts for a read-only file-viewer comment; the store owns
 *  the surface's annotation shape (always right-side, context = path+lines). */
export interface ProjectFileAnnotationInput {
  selectedText: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  comment: string;
}

export interface ProjectAnnotations {
  byFile: Record<string, StoredAnnotation[]>;
  chat: ChatAnnotation[];
  /** Read-only file-viewer comments, keyed by the project-relative path.
   * Separate from `byFile` (diff annotations) so the same path open in both
   * the Diffs and Files tabs doesn't share/clobber comments. */
  byProjectFile: Record<string, StoredAnnotation[]>;
  /** PR-viewer comments (diff lines, description, bot comments), keyed by an
   * opaque surface key like `<subPath>#<number>:<filePath|conversation>`. Kept
   * separate so PR notes accumulate into the same send-to-chat batch without
   * colliding with local-diff comments. */
  pr: Record<string, StoredAnnotation[]>;
}

const EMPTY: ProjectAnnotations = {
  byFile: {},
  chat: [],
  byProjectFile: {},
  pr: {},
};

const store = new Map<string, ProjectAnnotations>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storageKey(encoded: string): string {
  return `plan.annotations.${encoded}`;
}

// ── Revive parsed JSON back into typed annotations ──────────────────────────
// localStorage is untrusted (could be hand-edited or written by an older
// build), so we narrow each field and drop anything malformed rather than
// trusting the shape blindly. Exported for tests.

export function reviveCommentTarget(raw: unknown): CommentTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (t.kind === "file" && typeof t.path === "string") {
    return { kind: "file", path: t.path };
  }
  if (
    t.kind === "diff" &&
    typeof t.subPath === "string" &&
    typeof t.path === "string" &&
    typeof t.staged === "boolean"
  ) {
    return {
      kind: "diff",
      subPath: t.subPath,
      path: t.path,
      staged: t.staged,
    };
  }
  if (
    t.kind === "pr" &&
    typeof t.subPath === "string" &&
    typeof t.number === "number"
  ) {
    return {
      kind: "pr",
      subPath: t.subPath,
      number: t.number,
      file: typeof t.file === "string" ? t.file : undefined,
    };
  }
  if (t.kind === "chat" && typeof t.sessionId === "string") {
    return { kind: "chat", sessionId: t.sessionId };
  }
  return undefined;
}

export function reviveAnnotation(raw: unknown): StoredAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    typeof a.selectedText !== "string" ||
    typeof a.startOffset !== "number" ||
    typeof a.endOffset !== "number" ||
    typeof a.comment !== "string" ||
    (a.side !== "left" && a.side !== "right")
  ) {
    return null;
  }
  const annotation: StoredAnnotation = {
    id: a.id,
    selectedText: a.selectedText,
    startOffset: a.startOffset,
    endOffset: a.endOffset,
    comment: a.comment,
    side: a.side,
    target: reviveCommentTarget(a.target),
  };
  if (a.context && typeof a.context === "object") {
    const c = a.context as Record<string, unknown>;
    annotation.context = {
      filePath: typeof c.filePath === "string" ? c.filePath : undefined,
      startLine: typeof c.startLine === "number" ? c.startLine : undefined,
      endLine: typeof c.endLine === "number" ? c.endLine : undefined,
    };
  }
  return annotation;
}

/**
 * A span endpoint: {messageUuid, partIndex, offset}. `fallbackUuid` supplies the
 * message for the intermediate shape that stored it once at the top level
 * (start/end without their own uuid).
 */
function reviveChatSpan(raw: unknown, fallbackUuid: string): ChatSpan | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.partIndex !== "number" || typeof s.offset !== "number") {
    return null;
  }
  const messageUuid =
    typeof s.messageUuid === "string" ? s.messageUuid : fallbackUuid;
  if (!messageUuid) return null;
  return { messageUuid, partIndex: s.partIndex, offset: s.offset };
}

export function reviveChatAnnotation(raw: unknown): ChatAnnotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.id !== "string" ||
    typeof a.selectedText !== "string" ||
    typeof a.comment !== "string"
  ) {
    return null;
  }
  // A single (possibly absent) top-level uuid backfills older shapes that didn't
  // store the message per endpoint.
  const topUuid = typeof a.messageUuid === "string" ? a.messageUuid : "";

  // Current / intermediate shape: a span {start, end}, each a ChatSpan.
  const start = reviveChatSpan(a.start, topUuid);
  const end = reviveChatSpan(a.end, topUuid);
  if (start && end) {
    return {
      id: a.id,
      start,
      end,
      selectedText: a.selectedText,
      comment: a.comment,
      target: reviveCommentTarget(a.target),
    };
  }
  // Legacy shape: one part + char offsets. Migrate to a one-part span so comments
  // drafted by an older build survive the upgrade.
  if (
    topUuid &&
    typeof a.partIndex === "number" &&
    typeof a.startOffset === "number" &&
    typeof a.endOffset === "number"
  ) {
    return {
      id: a.id,
      start: {
        messageUuid: topUuid,
        partIndex: a.partIndex,
        offset: a.startOffset,
      },
      end: {
        messageUuid: topUuid,
        partIndex: a.partIndex,
        offset: a.endOffset,
      },
      selectedText: a.selectedText,
      comment: a.comment,
    };
  }
  return null;
}

/** Narrow a parsed `Record<string, StoredAnnotation[]>`, dropping malformed entries. */
function reviveByPath(raw: unknown): Record<string, StoredAnnotation[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, StoredAnnotation[]> = {};
  for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const revived = list
      .map(reviveAnnotation)
      .filter((a): a is StoredAnnotation => a !== null);
    if (revived.length > 0) out[path] = revived;
  }
  return out;
}

function load(encoded: string): ProjectAnnotations {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(storageKey(encoded));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as {
      byFile?: unknown;
      chat?: unknown;
      byProjectFile?: unknown;
      pr?: unknown;
    };
    return {
      byFile: reviveByPath(parsed.byFile),
      chat: Array.isArray(parsed.chat)
        ? parsed.chat
            .map(reviveChatAnnotation)
            .filter((a): a is ChatAnnotation => a !== null)
        : [],
      byProjectFile: reviveByPath(parsed.byProjectFile),
      pr: reviveByPath(parsed.pr),
    };
  } catch {
    return EMPTY;
  }
}

function persist(encoded: string, state: ProjectAnnotations) {
  if (typeof window === "undefined") return;
  try {
    // Drop the key entirely when there's nothing left, so cleared comments
    // don't linger as empty objects in storage.
    if (
      Object.keys(state.byFile).length === 0 &&
      state.chat.length === 0 &&
      Object.keys(state.byProjectFile).length === 0 &&
      Object.keys(state.pr).length === 0
    ) {
      window.localStorage.removeItem(storageKey(encoded));
      return;
    }
    window.localStorage.setItem(storageKey(encoded), JSON.stringify(state));
  } catch {
    // localStorage can throw (private mode / quota) — keep the in-memory value.
  }
}

/** Stable snapshot — returns the same reference until the project is mutated.
 *  Loads from localStorage on first touch for a given project. */
function get(encoded: string): ProjectAnnotations {
  let state = store.get(encoded);
  if (!state) {
    state = load(encoded);
    store.set(encoded, state);
  }
  return state;
}

function set(encoded: string, next: ProjectAnnotations) {
  store.set(encoded, next);
  persist(encoded, next);
  emit();
}

// ── Mutations ────────────────────────────────────────────────────────────────
// The three record-keyed surfaces (diff files, project files, PR notes) share
// one CRUD implementation; chat is a flat list with the same ops.

type RecordSlice = "byFile" | "byProjectFile" | "pr";

function addToRecord(
  encoded: string,
  slice: RecordSlice,
  key: string,
  ann: NewAnnotation,
) {
  const cur = get(encoded);
  set(encoded, {
    ...cur,
    [slice]: {
      ...cur[slice],
      [key]: [...(cur[slice][key] ?? []), { ...ann, id: crypto.randomUUID() }],
    },
  });
}

function updateInRecord(
  encoded: string,
  slice: RecordSlice,
  key: string,
  id: string,
  comment: string,
) {
  const cur = get(encoded);
  set(encoded, {
    ...cur,
    [slice]: {
      ...cur[slice],
      [key]: (cur[slice][key] ?? []).map((a) =>
        a.id === id ? { ...a, comment } : a,
      ),
    },
  });
}

function removeFromRecord(
  encoded: string,
  slice: RecordSlice,
  key: string,
  id: string,
) {
  const cur = get(encoded);
  set(encoded, {
    ...cur,
    [slice]: {
      ...cur[slice],
      [key]: (cur[slice][key] ?? []).filter((a) => a.id !== id),
    },
  });
}

function removeChat(encoded: string, id: string) {
  const cur = get(encoded);
  set(encoded, { ...cur, chat: cur.chat.filter((a) => a.id !== id) });
}

function clearRecordKey(encoded: string, slice: RecordSlice, key: string) {
  const cur = get(encoded);
  if (!(key in cur[slice])) return;
  const { [key]: _drop, ...rest } = cur[slice];
  set(encoded, { ...cur, [slice]: rest });
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Chat comments flattened into the plain Annotation shape for the outgoing
 *  message. Offsets only order the message; the span's endpoints suffice. */
function chatToAnnotations(chat: ChatAnnotation[]): Annotation[] {
  return chat.map((c) => ({
    id: c.id,
    selectedText: c.selectedText,
    startOffset: c.start.offset,
    endOffset: c.end.offset,
    comment: c.comment,
    side: "right",
  }));
}

/** One outgoing message combining every surface's comments, section by section,
 *  so a single compose box can Copy / Send-to-terminal everything at once. */
function composeMessage(state: ProjectAnnotations): string {
  const pr = Object.values(state.pr).flat();
  const projectFile = Object.values(state.byProjectFile).flat();
  const diff = Object.values(state.byFile).flat();
  const chat = chatToAnnotations(state.chat);

  const parts: string[] = [];
  if (pr.length > 0) {
    parts.push(
      "On the PR:\n\n" +
        generateMessage(pr, {
          intro: "",
          leftLabel: "the original",
          rightLabel: "the changes",
        }),
    );
  }
  if (projectFile.length > 0) {
    parts.push(
      "On the files:\n\n" + generateMessage(projectFile, { intro: "" }),
    );
  }
  if (diff.length > 0) {
    parts.push(
      "On the code changes:\n\n" +
        generateMessage(diff, {
          intro: "",
          leftLabel: "the original",
          rightLabel: "the changes",
        }),
    );
  }
  if (chat.length > 0) {
    parts.push(
      "On the conversation:\n\n" + generateMessage(chat, { intro: "" }),
    );
  }
  return parts.join("\n\n");
}

/** One row of the comment chip's list, in the order it appears in the message. */
export interface CommentListItem {
  id: string;
  /** Section heading from {@link composeMessage} — "On the files:" &c. */
  group: string;
  /** `path:L12-18` when the surface recorded one, else null. */
  location: string | null;
  selectedText: string;
  comment: string;
  target?: CommentTarget;
  remove: () => void;
}

function locationOf(a: StoredAnnotation): string | null {
  const ctx = a.context;
  if (!ctx?.filePath) return null;
  if (ctx.startLine == null) return ctx.filePath;
  const lines =
    ctx.endLine != null && ctx.endLine !== ctx.startLine
      ? `L${ctx.startLine}-${ctx.endLine}`
      : `L${ctx.startLine}`;
  return `${ctx.filePath}:${lines}`;
}

/** Every pending comment as a flat, numbered list — same order as the composed
 *  message, so what the chip shows reads the way Claude will receive it. */
function commentList(
  encoded: string,
  state: ProjectAnnotations,
): CommentListItem[] {
  const out: CommentListItem[] = [];
  const fromRecord = (
    slice: RecordSlice,
    record: Record<string, StoredAnnotation[]>,
    group: string,
  ) => {
    for (const [key, list] of Object.entries(record)) {
      for (const a of list) {
        out.push({
          id: a.id,
          group,
          location: locationOf(a),
          selectedText: a.selectedText,
          comment: a.comment,
          target: a.target,
          remove: () => removeFromRecord(encoded, slice, key, a.id),
        });
      }
    }
  };
  fromRecord("pr", state.pr, "PR");
  fromRecord("byProjectFile", state.byProjectFile, "Files");
  fromRecord("byFile", state.byFile, "Code changes");
  for (const c of state.chat) {
    out.push({
      id: c.id,
      group: "Conversation",
      location: null,
      selectedText: c.selectedText,
      comment: c.comment,
      target: c.target,
      remove: () => removeChat(encoded, c.id),
    });
  }
  return out;
}

function countComments(state: ProjectAnnotations): number {
  return (
    Object.values(state.byFile).flat().length +
    state.chat.length +
    Object.values(state.byProjectFile).flat().length +
    Object.values(state.pr).flat().length
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface ProjectAnnotationsApi {
  // Snapshots per surface (stable references between mutations).
  annotationsByFile: Record<string, StoredAnnotation[]>;
  chatAnnotations: ChatAnnotation[];
  annotationsByProjectFile: Record<string, StoredAnnotation[]>;
  annotationsByPr: Record<string, StoredAnnotation[]>;

  /** Total comments across every surface — drives the compose box. */
  totalComments: number;
  /** The outgoing send-to-chat message composed from every surface. */
  composedMessage: string;
  /** Every pending comment, flattened and ordered like the message. */
  comments: CommentListItem[];

  // Diff-viewer comments, keyed by file path (or a plan-card version-pair key).
  addFileAnnotation: (path: string, ann: NewAnnotation) => void;
  updateFileAnnotation: (path: string, id: string, comment: string) => void;
  removeFileAnnotation: (path: string, id: string) => void;
  /** Drop every comment on one diff file — its content changed, so the stored
   *  offsets no longer match the text on screen. */
  clearFileAnnotations: (path: string) => void;

  // Read-only file-viewer comments, keyed by project-relative path.
  addProjectFileAnnotation: (
    path: string,
    input: ProjectFileAnnotationInput,
  ) => void;
  updateProjectFileAnnotation: (
    path: string,
    id: string,
    comment: string,
  ) => void;
  removeProjectFileAnnotation: (path: string, id: string) => void;

  // PR-viewer comments, keyed by the caller's opaque surface key.
  addPrAnnotation: (key: string, ann: NewAnnotation) => void;
  updatePrAnnotation: (key: string, id: string, comment: string) => void;
  removePrAnnotation: (key: string, id: string) => void;

  // Chat comments.
  addChatAnnotation: (
    anchor: ChatAnchor,
    selectedText: string,
    comment: string,
    /** The chat this comment was made in, so the list can reopen that tab. */
    sessionId?: string,
  ) => void;
  updateChatAnnotation: (id: string, comment: string) => void;
  removeChatAnnotation: (id: string) => void;

  /** Discard every pending comment (sent with a message, or cleared by hand). */
  clearAll: () => void;
}

export function useProjectAnnotations(encoded: string): ProjectAnnotationsApi {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded),
  );

  // Mutations close over `encoded` only, so the whole ops object is stable for
  // a mounted workspace — memoized children keyed on individual ops don't
  // re-render when unrelated state changes.
  const ops = useMemo(
    () => ({
      addFileAnnotation: (path: string, ann: NewAnnotation) =>
        addToRecord(encoded, "byFile", path, ann),
      updateFileAnnotation: (path: string, id: string, comment: string) =>
        updateInRecord(encoded, "byFile", path, id, comment),
      removeFileAnnotation: (path: string, id: string) =>
        removeFromRecord(encoded, "byFile", path, id),
      clearFileAnnotations: (path: string) =>
        clearRecordKey(encoded, "byFile", path),

      addProjectFileAnnotation: (
        path: string,
        input: ProjectFileAnnotationInput,
      ) =>
        addToRecord(encoded, "byProjectFile", path, {
          selectedText: input.selectedText,
          startOffset: input.startOffset,
          endOffset: input.endOffset,
          comment: input.comment,
          side: "right",
          context: {
            filePath: path,
            startLine: input.startLine,
            endLine: input.endLine,
          },
          target: { kind: "file", path },
        }),
      updateProjectFileAnnotation: (
        path: string,
        id: string,
        comment: string,
      ) => updateInRecord(encoded, "byProjectFile", path, id, comment),
      removeProjectFileAnnotation: (path: string, id: string) =>
        removeFromRecord(encoded, "byProjectFile", path, id),

      addPrAnnotation: (key: string, ann: NewAnnotation) =>
        addToRecord(encoded, "pr", key, ann),
      updatePrAnnotation: (key: string, id: string, comment: string) =>
        updateInRecord(encoded, "pr", key, id, comment),
      removePrAnnotation: (key: string, id: string) =>
        removeFromRecord(encoded, "pr", key, id),

      addChatAnnotation: (
        anchor: ChatAnchor,
        selectedText: string,
        comment: string,
        sessionId?: string,
      ) => {
        const cur = get(encoded);
        set(encoded, {
          ...cur,
          chat: [
            ...cur.chat,
            {
              id: crypto.randomUUID(),
              start: anchor.start,
              end: anchor.end,
              selectedText,
              comment,
              target: sessionId ? { kind: "chat", sessionId } : undefined,
            },
          ],
        });
      },
      updateChatAnnotation: (id: string, comment: string) => {
        const cur = get(encoded);
        set(encoded, {
          ...cur,
          chat: cur.chat.map((a) => (a.id === id ? { ...a, comment } : a)),
        });
      },
      removeChatAnnotation: (id: string) => removeChat(encoded, id),

      clearAll: () => set(encoded, EMPTY),
    }),
    [encoded],
  );

  const { totalComments, composedMessage, comments } = useMemo(
    () => ({
      totalComments: countComments(snapshot),
      composedMessage: composeMessage(snapshot),
      comments: commentList(encoded, snapshot),
    }),
    [encoded, snapshot],
  );

  return {
    annotationsByFile: snapshot.byFile,
    chatAnnotations: snapshot.chat,
    annotationsByProjectFile: snapshot.byProjectFile,
    annotationsByPr: snapshot.pr,
    totalComments,
    composedMessage,
    comments,
    ...ops,
  };
}
