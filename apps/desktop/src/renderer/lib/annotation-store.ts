import { useCallback, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import type { ChatAnnotation } from "../components/message-list";

/**
 * In-progress comments (diff annotations + chat annotations) keyed by project
 * `encoded`. Lives at module scope so it survives `ProjectWorkspace` remounts —
 * the workspace is keyed by `encoded` in App, so without this the comments
 * would be lost every time the user switches projects in the first sidebar.
 *
 * Persisted to localStorage so the comments also survive a renderer refresh and
 * a full app quit & relaunch — a comment you've drafted but not yet sent to the
 * chat is real work and must not vanish when the window reloads.
 */
interface ProjectAnnotations {
  byFile: Record<string, Annotation[]>;
  chat: ChatAnnotation[];
  /** Read-only file-viewer comments, keyed by the project-relative path.
   * Separate from `byFile` (diff annotations) so the same path open in both
   * the Diffs and Files tabs doesn't share/clobber comments. */
  byProjectFile: Record<string, Annotation[]>;
}

const EMPTY: ProjectAnnotations = {
  byFile: {},
  chat: [],
  byProjectFile: {},
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
// trusting the shape blindly.

function reviveAnnotation(raw: unknown): Annotation | null {
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
  const annotation: Annotation = {
    id: a.id,
    selectedText: a.selectedText,
    startOffset: a.startOffset,
    endOffset: a.endOffset,
    comment: a.comment,
    side: a.side,
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
function reviveChatSpan(
  raw: unknown,
  fallbackUuid: string,
): { messageUuid: string; partIndex: number; offset: number } | null {
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

function reviveChatAnnotation(raw: unknown): ChatAnnotation | null {
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

/** Narrow a parsed `Record<string, Annotation[]>`, dropping malformed entries. */
function reviveByPath(raw: unknown): Record<string, Annotation[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Annotation[]> = {};
  for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const revived = list
      .map(reviveAnnotation)
      .filter((a): a is Annotation => a !== null);
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
    };
    return {
      byFile: reviveByPath(parsed.byFile),
      chat: Array.isArray(parsed.chat)
        ? parsed.chat
            .map(reviveChatAnnotation)
            .filter((a): a is ChatAnnotation => a !== null)
        : [],
      byProjectFile: reviveByPath(parsed.byProjectFile),
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
      Object.keys(state.byProjectFile).length === 0
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

export function useProjectAnnotations(encoded: string): {
  annotationsByFile: Record<string, Annotation[]>;
  setAnnotationsByFile: Dispatch<SetStateAction<Record<string, Annotation[]>>>;
  chatAnnotations: ChatAnnotation[];
  setChatAnnotations: Dispatch<SetStateAction<ChatAnnotation[]>>;
  annotationsByProjectFile: Record<string, Annotation[]>;
  setAnnotationsByProjectFile: Dispatch<
    SetStateAction<Record<string, Annotation[]>>
  >;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded),
  );

  const setAnnotationsByFile = useCallback<
    Dispatch<SetStateAction<Record<string, Annotation[]>>>
  >(
    (update) => {
      const cur = get(encoded);
      const next = typeof update === "function" ? update(cur.byFile) : update;
      set(encoded, { ...cur, byFile: next });
    },
    [encoded],
  );

  const setChatAnnotations = useCallback<
    Dispatch<SetStateAction<ChatAnnotation[]>>
  >(
    (update) => {
      const cur = get(encoded);
      const next = typeof update === "function" ? update(cur.chat) : update;
      set(encoded, { ...cur, chat: next });
    },
    [encoded],
  );

  const setAnnotationsByProjectFile = useCallback<
    Dispatch<SetStateAction<Record<string, Annotation[]>>>
  >(
    (update) => {
      const cur = get(encoded);
      const next =
        typeof update === "function" ? update(cur.byProjectFile) : update;
      set(encoded, { ...cur, byProjectFile: next });
    },
    [encoded],
  );

  return {
    annotationsByFile: snapshot.byFile,
    setAnnotationsByFile,
    chatAnnotations: snapshot.chat,
    setChatAnnotations,
    annotationsByProjectFile: snapshot.byProjectFile,
    setAnnotationsByProjectFile,
  };
}
