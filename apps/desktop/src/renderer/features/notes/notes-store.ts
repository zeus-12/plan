import { useEffect, useSyncExternalStore } from "react";
import type { NotesData, SessionNote } from "@/common/shared-types";
import { pushToast } from "@/renderer/lib/toast-store";
import { normalizeNoteText } from "./notes-format";

/**
 * The per-chat note stash: thoughts you want to send later, kept next to the
 * chat they belong to rather than in the composer draft (which holds exactly
 * one message).
 *
 * Module scope, keyed by project `encoded`, so it survives the ProjectWorkspace
 * remount a project switch causes — and so several mounted workspaces share one
 * copy. Backed by disk (main/store/notes-store), read once per project and
 * written after every discrete edit; there is no per-keystroke write because
 * editing a note commits on save, not while typing.
 */

const EMPTY: SessionNote[] = [];

/**
 * Whether a project's stash can be edited at all.
 *
 * `unreadable` is the important one: one file holds EVERY session's notes, so a
 * read that failed must not be mistaken for an empty stash — editing from
 * "empty" would write that emptiness back over every other chat's notes. In
 * that state the store refuses every mutation and the panel says so, until a
 * retry succeeds.
 */
export type NotesStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unreadable"; error: string };

const LOADING: NotesStatus = { kind: "loading" };
const READY: NotesStatus = { kind: "ready" };

const store = new Map<string, NotesData>();
const status = new Map<string, NotesStatus>();
/** Resolves once a project's stash has been read off disk. */
const loads = new Map<string, Promise<void>>();
/** Serializes a project's writes, so two quick edits can't land out of order. */
const writes = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function ensureLoaded(encoded: string): Promise<void> {
  const existing = loads.get(encoded);
  if (existing) return existing;
  const p = window.electronAPI
    .readNotes(encoded)
    .then((data) => {
      // A mutation can't land before this: every mutator awaits this promise.
      store.set(encoded, data ?? { sessions: {} });
      status.set(encoded, READY);
      emit();
    })
    .catch((err: unknown) => {
      // Deliberately NOT an empty stash — see NotesStatus.
      status.set(encoded, {
        kind: "unreadable",
        error: err instanceof Error ? err.message : String(err),
      });
      emit();
    });
  loads.set(encoded, p);
  return p;
}

/** Re-read a stash that failed to load (the panel's Retry). */
export function reloadNotes(encoded: string): Promise<void> {
  loads.delete(encoded);
  status.set(encoded, LOADING);
  emit();
  return ensureLoaded(encoded);
}

function persist(encoded: string) {
  const data = store.get(encoded);
  if (!data || status.get(encoded)?.kind !== "ready") return;
  const snapshot: NotesData = { sessions: { ...data.sessions } };
  const prev = writes.get(encoded) ?? Promise.resolve();
  const next = prev
    .then(() => window.electronAPI.writeNotes(encoded, snapshot))
    .catch((err: unknown) => {
      // A note that looks saved and isn't is worse than a loud failure.
      pushToast({
        title: "Couldn't save notes",
        description: err instanceof Error ? err.message : String(err),
        id: "notes-write-failed",
      });
    });
  writes.set(encoded, next);
}

/** Apply `fn` to one session's list, then emit + persist. No-op (and says so)
 *  while the stash is unreadable, so an edit can never overwrite it. */
async function mutate(
  encoded: string,
  sessionId: string,
  fn: (notes: SessionNote[]) => SessionNote[],
): Promise<void> {
  await ensureLoaded(encoded);
  const data = store.get(encoded);
  if (!data || status.get(encoded)?.kind !== "ready") {
    pushToast({
      title: "Notes are read-only",
      description:
        "The stash on disk couldn't be read, so nothing was changed.",
      id: "notes-readonly",
    });
    return;
  }
  const next = fn(data.sessions[sessionId] ?? EMPTY);
  const sessions = { ...data.sessions };
  if (next.length === 0) delete sessions[sessionId];
  else sessions[sessionId] = next;
  store.set(encoded, { sessions });
  emit();
  persist(encoded);
}

function read(encoded: string, sessionId: string | null): SessionNote[] {
  if (!sessionId) return EMPTY;
  return store.get(encoded)?.sessions[sessionId] ?? EMPTY;
}

/** One chat's notes, oldest first. Empty until the project's stash has loaded. */
export function useSessionNotes(
  encoded: string,
  sessionId: string | null,
): SessionNote[] {
  useEffect(() => {
    void ensureLoaded(encoded);
  }, [encoded]);
  return useSyncExternalStore(
    subscribe,
    () => read(encoded, sessionId),
    () => read(encoded, sessionId),
  );
}

/** Whether this project's stash loaded, and why not when it didn't. */
export function useNotesStatus(encoded: string): NotesStatus {
  useEffect(() => {
    void ensureLoaded(encoded);
  }, [encoded]);
  return useSyncExternalStore(
    subscribe,
    () => status.get(encoded) ?? LOADING,
    () => status.get(encoded) ?? LOADING,
  );
}

/** How many open (not-done) notes a chat has — drives the tab's count badge. */
export function useOpenNoteCount(
  encoded: string,
  sessionId: string | null,
): number {
  return useSessionNotes(encoded, sessionId).filter((n) => !n.done).length;
}

/** Add a note. Returns its id, or null when the text was blank. */
export async function addNote(
  encoded: string,
  sessionId: string,
  text: string,
  source?: string,
): Promise<string | null> {
  const clean = normalizeNoteText(text);
  if (!clean) return null;
  const note: SessionNote = {
    id: crypto.randomUUID(),
    text: clean,
    done: false,
    createdAt: Date.now(),
    ...(source ? { source } : {}),
  };
  await mutate(encoded, sessionId, (notes) => [...notes, note]);
  return note.id;
}

export function updateNoteText(
  encoded: string,
  sessionId: string,
  id: string,
  text: string,
): Promise<void> {
  const clean = normalizeNoteText(text);
  if (!clean) return removeNotes(encoded, sessionId, [id]);
  return mutate(encoded, sessionId, (notes) =>
    notes.map((n) => (n.id === id ? { ...n, text: clean } : n)),
  );
}

export function setNotesDone(
  encoded: string,
  sessionId: string,
  ids: string[],
  done: boolean,
): Promise<void> {
  const set = new Set(ids);
  return mutate(encoded, sessionId, (notes) =>
    notes.map((n) => (set.has(n.id) ? { ...n, done } : n)),
  );
}

export function removeNotes(
  encoded: string,
  sessionId: string,
  ids: string[],
): Promise<void> {
  const set = new Set(ids);
  return mutate(encoded, sessionId, (notes) =>
    notes.filter((n) => !set.has(n.id)),
  );
}

/** Merge several notes into one, in list order — the survivor keeps its slot. */
export function mergeNotes(
  encoded: string,
  sessionId: string,
  ids: string[],
): Promise<void> {
  const set = new Set(ids);
  return mutate(encoded, sessionId, (notes) => {
    const picked = notes.filter((n) => set.has(n.id));
    if (picked.length < 2) return notes;
    // No `source`: a merged note no longer came from one place.
    const merged: SessionNote = {
      id: picked[0].id,
      createdAt: picked[0].createdAt,
      done: picked[0].done,
      text: picked.map((n) => n.text).join("\n\n"),
    };
    let placed = false;
    const out: SessionNote[] = [];
    for (const n of notes) {
      if (!set.has(n.id)) {
        out.push(n);
        continue;
      }
      if (!placed) {
        out.push(merged);
        placed = true;
      }
    }
    return out;
  });
}

/**
 * Follow a chat whose session id changed under it — a `/branch` fork moves the
 * live conversation from A to B, and notes stashed for it are real work that
 * belongs to the conversation, not to the id it used to have. Never clobbers
 * notes B already has.
 */
export async function rekeyNotes(
  encoded: string,
  oldSid: string,
  newSid: string,
): Promise<void> {
  await ensureLoaded(encoded);
  if (status.get(encoded)?.kind !== "ready") return;
  const data = store.get(encoded);
  const moving = data?.sessions[oldSid];
  if (!data || !moving || data.sessions[newSid]) return;
  const sessions = { ...data.sessions, [newSid]: moving };
  delete sessions[oldSid];
  store.set(encoded, { sessions });
  emit();
  persist(encoded);
}

/** Archiving a chat puts it away — its stash goes with it. */
export async function forgetSessionNotes(
  encoded: string,
  sessionId: string,
): Promise<void> {
  await ensureLoaded(encoded);
  if (status.get(encoded)?.kind !== "ready") return;
  const data = store.get(encoded);
  if (!data?.sessions[sessionId]) return;
  const sessions = { ...data.sessions };
  delete sessions[sessionId];
  store.set(encoded, { sessions });
  emit();
  persist(encoded);
}
