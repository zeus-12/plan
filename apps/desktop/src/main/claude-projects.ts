import { readdir, readFile, open, mkdir, rename, access } from "fs/promises";
import { join } from "path";
import {
  CLAUDE_PROJECTS_DIR,
  newestSessionFile,
  sessionFilePath,
} from "./claude-sessions";
import { decodeProjectDir } from "./claude-encoding";

/**
 * Physically relocate a session's transcript from one project dir to another —
 * the on-disk half of "move chat to worktree". Claude keys a session's dir by
 * the cwd it ran in, so moving the `<sessionId>.jsonl` into the target's
 * encoded dir + resuming there (`claude --resume`) re-homes the conversation in
 * the new worktree without copying any of the working-tree code (verified: new
 * turns anchor to the launch cwd; prior turns keep their historical cwd).
 *
 * A brand-new chat may not have written a transcript yet — nothing to move, and
 * `--session-id` in the new cwd will create it there — so a missing source is a
 * no-op, not an error.
 */
export async function moveSessionTranscript(
  sessionId: string,
  fromEncoded: string,
  toEncoded: string,
): Promise<void> {
  if (fromEncoded === toEncoded) return;
  const src = sessionFilePath(fromEncoded, sessionId);
  try {
    await access(src);
  } catch {
    return; // transcript not materialized yet — nothing to relocate
  }
  await mkdir(join(CLAUDE_PROJECTS_DIR, toEncoded), { recursive: true });
  // Same filesystem (both under ~/.claude), so rename is atomic and cheap.
  await rename(src, sessionFilePath(toEncoded, sessionId));
}

const cwdCache = new Map<string, string>();

/** First `"cwd":"..."` occurrence in a JSONL body. */
function extractCwd(jsonl: string): string | null {
  const m = jsonl.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

// The cwd field lives on the first line of a normal transcript (a few lines in
// on compacted ones, after the summary entries), so a bounded head read finds
// it without pulling a multi-MB file into memory. A value split by the chunk
// boundary can't half-match (the regex needs the closing quote), so a miss on
// an incomplete head falls back to the full read — exact, never guessed.
const CWD_HEAD_BYTES = 64 * 1024;

async function readHead(
  filePath: string,
  bytes: number,
): Promise<{ text: string; complete: boolean }> {
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, 0);
    return { text: buf.toString("utf-8"), complete: len >= size };
  } finally {
    await fh.close();
  }
}

/**
 * Seed the cwd cache for an encoded key whose real path we already know (e.g. a
 * worktree checkout that has no Claude session JSONL yet). Lets all the
 * `(encoded, subPath)` git ops resolve to the worktree without a transcript.
 */
export function primeProjectCwd(encoded: string, cwd: string): void {
  cwdCache.set(encoded, cwd);
}

/**
 * Resolve a project's real working directory by reading the `cwd` field from
 * its most recent session JSONL. Cached. Falls back to the lossy decode when
 * no session file is readable.
 */
export async function resolveProjectCwd(encoded: string): Promise<string> {
  const cached = cwdCache.get(encoded);
  if (cached) return cached;

  try {
    // The most recently modified session file has the freshest cwd.
    const newest = await newestSessionFile(encoded);
    if (newest) {
      const head = await readHead(newest.filePath, CWD_HEAD_BYTES);
      let cwd = extractCwd(head.text);
      if (!cwd && !head.complete) {
        cwd = extractCwd(await readFile(newest.filePath, "utf-8"));
      }
      if (cwd) {
        cwdCache.set(encoded, cwd);
        return cwd;
      }
    }
  } catch {
    // fall through to decode
  }

  const fallback = decodeProjectDir(encoded);
  cwdCache.set(encoded, fallback);
  return fallback;
}

/**
 * Just the encoded dir names under `~/.claude/projects` — what watcher setup
 * needs at boot. Deliberately no cwd resolution: the old full listing read
 * every project's newest transcript at launch only to throw the cwds away.
 */
export async function listProjectEncodeds(): Promise<string[]> {
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
