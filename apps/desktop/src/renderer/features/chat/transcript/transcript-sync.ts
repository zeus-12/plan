import type { ParsedSession } from "@/common/shared-types";

/**
 * Renderer side of the incremental `session:read` protocol. Main keeps a fold
 * of each followed transcript; we keep the last assembled ParsedSession and the
 * fold's `gen`, and ask only for the messages we don't have yet. A stale cursor
 * (fold evicted, file rewritten, first read) comes back as `mode: "full"` and
 * simply replaces our copy — the cursor can never desync the transcript.
 *
 * Module scope (like session-cache) so cursors survive the per-project
 * workspace remount: revisiting a project keeps appending instead of paying a
 * full re-read.
 */

interface SyncState {
  gen: number;
  session: ParsedSession;
}

const states = new Map<string, SyncState>();
// Per-session fetches are chained: two overlapping fetches with the same
// cursor would both append the same delta. Serializing makes each fetch see
// its predecessor's result as `prev`.
const chains = new Map<string, Promise<ParsedSession | null>>();

const keyOf = (encoded: string, sessionId: string) => `${encoded}:${sessionId}`;

export function fetchTranscript(
  encoded: string,
  sessionId: string,
): Promise<ParsedSession | null> {
  const key = keyOf(encoded, sessionId);
  const run = () => fetchOnce(key, encoded, sessionId);
  const p = (chains.get(key) ?? Promise.resolve(null)).then(run, run);
  chains.set(key, p);
  void p.finally(() => {
    if (chains.get(key) === p) chains.delete(key);
  });
  return p;
}

/** Forget a session's cursor (chat tab closed) so `states` tracks open tabs. */
export function dropTranscript(encoded: string, sessionId: string): void {
  states.delete(keyOf(encoded, sessionId));
}

async function fetchOnce(
  key: string,
  encoded: string,
  sessionId: string,
  retried = false,
): Promise<ParsedSession | null> {
  const prev = states.get(key);
  const client = prev
    ? { gen: prev.gen, have: prev.session.messages.length }
    : undefined;
  const res = await window.electronAPI.readSession(encoded, sessionId, client);
  if (!res) {
    states.delete(key);
    return null;
  }

  let session: ParsedSession;
  if (res.mode === "append" && prev) {
    if (prev.session.messages.length + res.messages.length !== res.total) {
      // Cursor drift (shouldn't happen — gen guards it). Refetch from scratch
      // once rather than trust a transcript we can't verify.
      states.delete(key);
      if (retried) return null;
      return fetchOnce(key, encoded, sessionId, true);
    }
    session =
      res.messages.length === 0
        ? { meta: res.meta, messages: prev.session.messages }
        : {
            meta: res.meta,
            messages: prev.session.messages.concat(res.messages),
          };
  } else {
    session = { meta: res.meta, messages: res.messages };
  }
  states.set(key, { gen: res.gen, session });
  return session;
}
