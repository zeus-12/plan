import { readdir, stat, readFile, mkdir, rename, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

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
  const src = join(CLAUDE_PROJECTS_DIR, fromEncoded, `${sessionId}.jsonl`);
  try {
    await access(src);
  } catch {
    return; // transcript not materialized yet — nothing to relocate
  }
  const destDir = join(CLAUDE_PROJECTS_DIR, toEncoded);
  await mkdir(destDir, { recursive: true });
  // Same filesystem (both under ~/.claude), so rename is atomic and cheap.
  await rename(src, join(destDir, `${sessionId}.jsonl`));
}

export interface ProjectEntry {
  encoded: string;
  cwd: string;
  mtimeMs: number;
}

// Note: the type exposed to the renderer adds `archived` and is defined in
// shared-types. listProjects() returns the raw fs-only shape; main/index.ts
// layers `archived` on top.

/**
 * Claude encodes a project cwd into a directory name by replacing path
 * separators with hyphens. The reverse is LOSSY — a real "-", space, or
 * other special char in a directory name is indistinguishable from a
 * separator (e.g. "copilot (ic)" → "copilot--ic-"). Use this only as a
 * last-resort fallback; prefer resolveProjectCwd() which reads the real cwd
 * from the session JSONL.
 */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
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

/**
 * Resolve a project's real working directory by reading the `cwd` field from
 * its most recent session JSONL. Cached. Falls back to the lossy decode when
 * no session file is readable.
 */
/**
 * Seed the cwd cache for an encoded key whose real path we already know (e.g. a
 * worktree checkout that has no Claude session JSONL yet). Lets all the
 * `(encoded, subPath)` git ops resolve to the worktree without a transcript.
 */
export function primeProjectCwd(encoded: string, cwd: string): void {
  cwdCache.set(encoded, cwd);
}

export async function resolveProjectCwd(encoded: string): Promise<string> {
  const cached = cwdCache.get(encoded);
  if (cached) return cached;

  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  try {
    const entries = await readdir(dir);
    const jsonls = entries.filter((e) => e.endsWith(".jsonl"));
    // Pick the most recently modified session file.
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const name of jsonls) {
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (!newest || s.mtimeMs > newest.mtimeMs) {
          newest = { path: p, mtimeMs: s.mtimeMs };
        }
      } catch {
        // skip
      }
    }
    if (newest) {
      const body = await readFile(newest.path, "utf-8");
      const cwd = extractCwd(body);
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

export async function listProjects(): Promise<ProjectEntry[]> {
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    const out: ProjectEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const s = await stat(join(CLAUDE_PROJECTS_DIR, e.name));
        out.push({
          encoded: e.name,
          // Real cwd resolved from the JSONL (cached); decode is the fallback.
          cwd: await resolveProjectCwd(e.name),
          mtimeMs: s.mtimeMs,
        });
      } catch {
        // skip
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch {
    return [];
  }
}
