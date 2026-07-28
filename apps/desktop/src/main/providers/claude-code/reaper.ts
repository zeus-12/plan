import { unlink } from "fs/promises";
import { readSessionFile } from "./transcript";

/**
 * Reap the ghost transcript left behind when a chat is moved out of a project.
 *
 * "Move chat to worktree" (and create-worktree-from-session) renames the
 * `<sessionId>.jsonl` into the target project's dir — the on-disk half of the
 * move (see moveSessionTranscript). But the source `claude` is not guaranteed
 * dead the instant we rename: it runs as a child of the pty's shell, so killing
 * the pty (SIGHUP to the shell) doesn't reliably reap it, and even a clean
 * shutdown flushes one last session-state snapshot — `mode` / `permission-mode`
 * / `ai-title` / `last-prompt`, with NO conversation turns — to the path derived
 * from its old cwd. With the real transcript already renamed away, that flush
 * RE-CREATES a message-less `<sessionId>.jsonl` at the OLD path: a ghost that
 * lists as "no message" and never goes away.
 *
 * We can't reliably win that race — we don't own claude's write timing, and it
 * can even re-create the file after we delete it (it appends open-then-close).
 * So instead of racing we neutralize the ghost deterministically by identity:
 * once session X has been relocated OUT of project A, any `X.jsonl` that appears
 * in A is provably stale — the live transcript now lives in B, and a genuinely
 * new session in A would carry a fresh id. We additionally require the
 * reappeared file to hold ZERO conversation turns before deleting, so a later
 * move-BACK of the same session (its full transcript, with turns) is untouched.
 * That zero-turn guard is what makes a wrong delete impossible regardless of
 * timing, which in turn lets the arming window be a generous upper bound rather
 * than a correctness knob.
 */

// claude's shutdown flush lands within seconds of the move; two minutes is a
// comfortable upper bound. Not a correctness value — the zero-turn guard in
// reapRelocatedStub prevents any wrong delete no matter how long we stay armed.
const REAP_WINDOW_MS = 120_000;

// encoded -> (sessionId -> disarm timer). Presence == "a stub for this session
// reappearing in this project is stale; reap it on sight."
const armed = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

function disarm(encoded: string, sessionId: string): void {
  const forProject = armed.get(encoded);
  if (!forProject) return;
  const t = forProject.get(sessionId);
  if (t) clearTimeout(t);
  forProject.delete(sessionId);
  if (forProject.size === 0) armed.delete(encoded);
}

/** Arm reaping of `sessionId`'s ghost in the project it was just moved out of. */
export function markSessionMovedAway(encoded: string, sessionId: string): void {
  let forProject = armed.get(encoded);
  if (!forProject) {
    forProject = new Map();
    armed.set(encoded, forProject);
  }
  const existing = forProject.get(sessionId);
  if (existing) clearTimeout(existing);
  forProject.set(
    sessionId,
    setTimeout(() => disarm(encoded, sessionId), REAP_WINDOW_MS),
  );
}

/**
 * If a file just appeared/changed at a moved-away session's origin path, decide
 * its fate. Returns true when it was a zero-turn ghost and we deleted it (the
 * caller must swallow the corresponding session event so the renderer never
 * sees it); false otherwise. A file WITH turns means the session legitimately
 * lives here again (e.g. moved back) — we disarm and leave it alone.
 */
export async function reapRelocatedStub(
  encoded: string,
  sessionId: string,
  filePath: string,
): Promise<boolean> {
  if (!armed.get(encoded)?.has(sessionId)) return false;
  let hasTurns: boolean;
  try {
    const parsed = await readSessionFile(filePath);
    hasTurns = parsed.messages.length > 0;
  } catch {
    // Unreadable (vanished mid-write) — never delete on uncertainty.
    return false;
  }
  if (hasTurns) {
    disarm(encoded, sessionId);
    return false;
  }
  try {
    await unlink(filePath);
  } catch {
    // Already gone — fine, the ghost is neutralized either way.
  }
  // Stay armed: claude may re-create the stub once more before it exits.
  return true;
}

/** Drop all arming timers (teardown). */
export function clearRelocationGuards(): void {
  for (const forProject of armed.values())
    for (const t of forProject.values()) clearTimeout(t);
  armed.clear();
}
