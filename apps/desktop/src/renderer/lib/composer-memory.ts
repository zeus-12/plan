import {
  createEmptyHistoryState,
  type HistoryState,
} from "@lexical/react/LexicalHistoryPlugin";
import type { LexicalEditor } from "lexical";

/**
 * What each chat's composer remembers between visits: its undo history and the
 * last message sent from it.
 *
 * Lives at module scope because both outlive the composer. ChatInput unmounts
 * whenever the centre pane shows a diff or file tab, and App evicts whole
 * workspaces from its mount pool — either would otherwise take the history with
 * it, and reopening a chat is exactly when you want it back.
 *
 * History is kept as SERIALIZED editor states rather than Lexical's own
 * HistoryState. Its entries are `{editor, editorState}` and `undo()` applies the
 * popped state to the editor named in the entry, so a stack cannot be handed to
 * a later editor — it has to be rebuilt into whichever one is live. Holding only
 * strings in between is also what keeps a dead LexicalEditor (and its detached
 * DOM) from being retained here.
 *
 * In memory only: an app restart starts everyone fresh. Archiving a chat or its
 * project drops it (see forgetSession / forgetProject).
 */

// Both caps bound memory — an undo entry is a full editor-state clone, and
// HistoryPlugin gives no way to bound the live stack itself (registerHistory's
// maxDepth defaults to null and the plugin never passes one).
const MAX_DEPTH = 30;
const MAX_SESSIONS = 20;

interface SessionMemory {
  /** Serialized editor states, oldest first — undo walks back from the end. */
  undo: string[];
  /** Last message sent from this chat; ⌘Z restores it into an empty box. */
  lastSent: string | null;
  /** Owning project, so archiving one can drop every chat under it. */
  encoded: string;
}

// Insertion-ordered: the oldest entry is the least recently used, because every
// touch re-inserts. Pruned on insert.
const sessions = new Map<string, SessionMemory>();

/** Mark `sid` as most recently used, if we know it. */
function touch(sid: string): SessionMemory | undefined {
  const mem = sessions.get(sid);
  if (!mem) return undefined;
  sessions.delete(sid);
  sessions.set(sid, mem);
  return mem;
}

function memoryFor(sid: string, encoded: string): SessionMemory {
  const existing = touch(sid);
  if (existing) return existing;
  const created: SessionMemory = { undo: [], lastSent: null, encoded };
  sessions.set(sid, created);
  for (const dead of [...sessions.keys()].slice(0, -MAX_SESSIONS))
    sessions.delete(dead);
  return created;
}

/**
 * This chat's undo stack, rebuilt against `editor`. Every entry is parsed into
 * the live editor, so the stack Lexical gets always belongs to it.
 */
export function takeHistory(editor: LexicalEditor, sid: string): HistoryState {
  const state = createEmptyHistoryState();
  const mem = sessions.get(sid);
  if (!mem) return state;
  for (const json of mem.undo) {
    try {
      state.undoStack.push({
        editor,
        editorState: editor.parseEditorState(json),
      });
    } catch {
      // A state an older build wrote just isn't undoable; the rest still are.
    }
  }
  return state;
}

/** Serialize a live stack back into memory — called when the chat goes away. */
export function saveHistory(sid: string, encoded: string, state: HistoryState) {
  const entries = state.undoStack.slice(-MAX_DEPTH);
  if (entries.length === 0 && !sessions.has(sid)) return;
  memoryFor(sid, encoded).undo = entries.map((e) =>
    JSON.stringify(e.editorState.toJSON()),
  );
}

/** Bound a live stack, which Lexical would otherwise let grow forever. */
export function capHistoryDepth(state: HistoryState) {
  const over = state.undoStack.length - MAX_DEPTH;
  if (over > 0) state.undoStack.splice(0, over);
}

export function readLastSent(sid: string): string | null {
  return sessions.get(sid)?.lastSent ?? null;
}

export function writeLastSent(sid: string, encoded: string, state: string) {
  memoryFor(sid, encoded).lastSent = state;
}

/** A restore consumes the buffer, so a second ⌘Z falls through to Lexical. */
export function clearLastSent(sid: string) {
  const mem = sessions.get(sid);
  if (mem) mem.lastSent = null;
}

/** Archiving a chat puts it away — its composer memory goes with it. */
export function forgetSession(sid: string) {
  sessions.delete(sid);
}

export function forgetProject(encoded: string) {
  for (const [sid, mem] of sessions)
    if (mem.encoded === encoded) sessions.delete(sid);
}

/**
 * Follow a chat whose session id changed under it — a `/branch` fork moves the
 * live conversation from A to B, and what you typed seconds earlier should stay
 * undoable. Never clobbers memory B already has.
 */
export function rekeySession(oldSid: string, newSid: string) {
  const mem = sessions.get(oldSid);
  if (!mem || sessions.has(newSid)) return;
  sessions.delete(oldSid);
  sessions.set(newSid, mem);
}
