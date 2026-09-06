import { readFile, mkdir, rename, writeFile, rm } from "fs/promises";
import { join } from "path";
import { PLAN_DIR } from "./plan-config";
import type { NotesData, SessionNote } from "@/common/shared-types";

/**
 * Per-chat note stashes, persisted under `~/.plan/notes/<encoded>.json`.
 *
 * One file per project (keyed by `encoded`, as the scratchpad and tab state
 * are), holding every session's notes — a note is a few hundred bytes, so the
 * whole project's stash is a single small read on workspace mount and a single
 * write per edit. On disk rather than localStorage so a stash survives a
 * renderer refresh and never competes for the quota the tab state lives in.
 *
 * Because ONE file holds every session's notes, a read that fails must never be
 * reported as "no notes": the renderer would start from an empty stash and the
 * next edit would write it back over everyone else's. So `readNotes` returns
 * null ONLY for a file that isn't there, and throws for anything else — a
 * missing file and an unreadable one are different answers. Writes go through a
 * temp file and a rename, so a crash mid-write can't leave a half-written stash
 * behind either.
 */

const NOTES_DIR = join(PLAN_DIR, "notes");

function notesPath(encoded: string): string {
  return join(NOTES_DIR, `${encoded}.json`);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function reviveNote(raw: unknown): SessionNote | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Partial<SessionNote>;
  if (typeof n.id !== "string" || typeof n.text !== "string") return null;
  return {
    id: n.id,
    text: n.text,
    done: n.done === true,
    createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
    ...(typeof n.source === "string" ? { source: n.source } : {}),
  };
}

/**
 * A project's note stash, or null when it has never been written.
 *
 * Throws when the file exists but could not be read or parsed. The caller must
 * NOT treat that as an empty stash — see the note above.
 */
export async function readNotes(encoded: string): Promise<NotesData | null> {
  let raw: string;
  try {
    raw = await readFile(notesPath(encoded), "utf-8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<NotesData> | undefined;
  const bySession = parsed?.sessions;
  if (!bySession || typeof bySession !== "object") {
    throw new Error(`notes file for ${encoded} has no sessions map`);
  }
  const sessions: Record<string, SessionNote[]> = {};
  for (const [sid, list] of Object.entries(bySession)) {
    if (!Array.isArray(list)) continue;
    const notes = list
      .map(reviveNote)
      .filter((n): n is SessionNote => n !== null);
    if (notes.length > 0) sessions[sid] = notes;
  }
  return { sessions };
}

/** Write via temp file + rename, so an interrupted write leaves the previous
 *  stash intact rather than a truncated one. */
export async function writeNotes(
  encoded: string,
  data: NotesData,
): Promise<void> {
  await mkdir(NOTES_DIR, { recursive: true });
  const target = notesPath(encoded);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf-8");
  await rename(tmp, target);
}

/** Delete a project's note file (no-op if it never wrote one). */
export async function deleteNotes(encoded: string): Promise<void> {
  await rm(notesPath(encoded), { force: true });
}
