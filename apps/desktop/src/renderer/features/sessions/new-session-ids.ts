/**
 * Sessions created from the UI this run (via `claude --session-id <uuid>`).
 * Their JSONL doesn't exist until the first exchange, so selection and the
 * first terminal spawn treat them specially (new session → `--session-id`,
 * existing → `--resume`).
 *
 * Module-scoped so it's shared across every ProjectWorkspace mount and reachable
 * from App (e.g. after moving a session to a worktree, we `forget` it so its
 * relocated transcript is picked up with `--resume`, not re-created).
 */
const NEW_SESSION_IDS = new Set<string>();

export function markNewSession(sessionId: string): void {
  NEW_SESSION_IDS.add(sessionId);
}

export function isNewSession(sessionId: string): boolean {
  return NEW_SESSION_IDS.has(sessionId);
}

/**
 * Drop a session from the "brand new" set so it resumes instead of being
 * created. Called after its transcript has been written or relocated.
 */
export function forgetNewSession(sessionId: string): void {
  NEW_SESSION_IDS.delete(sessionId);
}
