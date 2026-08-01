import type { ParsedSession } from "@/common/shared-types";
import type { SessionListItem } from "./session-list";

/**
 * Per-worktree (encoded) cache of the session LIST and the parsed transcripts of
 * open chat tabs. `ProjectWorkspace` is keyed by `encoded`, so switching
 * worktrees remounts it and would otherwise drop this data — forcing a cold
 * re-list + re-parse over IPC and flashing "Loading…" across the sidebar and
 * chat for a few seconds. Mirrors the existing per-encoded module stores
 * (tabs/terminals/annotations): on mount the workspace seeds its state from here
 * for an instant paint, then refreshes in the background.
 *
 * Module scope so it outlives the keyed remount. Only written AFTER a real load,
 * so an entry's presence means "this worktree has been loaded once" (distinct
 * from a genuine empty list).
 */
interface CachedWorkspaceSessions {
  sessions: SessionListItem[];
  transcripts: Map<string, ParsedSession>;
}

const cache = new Map<string, CachedWorkspaceSessions>();

function entry(encoded: string): CachedWorkspaceSessions {
  let c = cache.get(encoded);
  if (!c) {
    c = { sessions: [], transcripts: new Map() };
    cache.set(encoded, c);
  }
  return c;
}

/** Last-loaded session list, or null if this worktree was never loaded. */
export function getCachedSessions(encoded: string): SessionListItem[] | null {
  return cache.get(encoded)?.sessions ?? null;
}

export function setCachedSessions(
  encoded: string,
  sessions: SessionListItem[],
): void {
  entry(encoded).sessions = sessions;
}

/**
 * Drop one session from a worktree's cached list + transcripts — used after
 * moving a chat out of it, so the source view (which seeds from this cache on
 * remount) doesn't briefly show the now-relocated session.
 */
export function removeCachedSession(encoded: string, sessionId: string): void {
  const c = cache.get(encoded);
  if (!c) return;
  c.sessions = c.sessions.filter((s) => s.sessionId !== sessionId);
  c.transcripts.delete(sessionId);
}

/** Last-known transcripts for open chat tabs (empty Map if none cached). */
export function getCachedTranscripts(
  encoded: string,
): Map<string, ParsedSession> | null {
  return cache.get(encoded)?.transcripts ?? null;
}

export function setCachedTranscripts(
  encoded: string,
  transcripts: Map<string, ParsedSession>,
): void {
  entry(encoded).transcripts = transcripts;
}
