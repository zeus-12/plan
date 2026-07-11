import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { readSessionMeta } from "./jsonl-parser";
import type { SessionListEntry } from "../shared-types";

/**
 * Session discovery — the one module that reads `~/.claude/projects/<encoded>`.
 * Every "what session files does this project have" question (list them, find
 * the newest, max activity, seed a watcher) goes through the scan primitives
 * here instead of re-implementing the readdir→filter→stat walk.
 */

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Canonical on-disk path of one session's transcript. */
export function sessionFilePath(encoded: string, sessionId: string): string {
  return join(CLAUDE_PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
}

export interface SessionFile {
  sessionId: string;
  filePath: string;
}

export interface SessionFileStat extends SessionFile {
  mtimeMs: number;
}

/** All session transcripts in a project dir (names only — no stat calls). */
export async function listSessionFiles(
  encoded: string,
): Promise<SessionFile[]> {
  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => ({
        sessionId: e.name.replace(/\.jsonl$/, ""),
        filePath: join(dir, e.name),
      }));
  } catch {
    return []; // dir may not exist yet
  }
}

/** Session transcripts with their mtimes; files that vanish mid-scan are skipped. */
export async function scanSessionFiles(
  encoded: string,
): Promise<SessionFileStat[]> {
  const files = await listSessionFiles(encoded);
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(f.filePath);
        return { ...f, mtimeMs: s.mtimeMs };
      } catch {
        return null; // vanished mid-scan
      }
    }),
  );
  return stats.filter((f): f is SessionFileStat => f !== null);
}

/** Most recent session-file mtime for a project (for activity sorting). */
export async function latestActivity(encoded: string): Promise<number> {
  const files = await scanSessionFiles(encoded);
  return files.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
}

/** The most recently modified session transcript, or null when none exist. */
export async function newestSessionFile(
  encoded: string,
): Promise<SessionFileStat | null> {
  const files = await scanSessionFiles(encoded);
  let newest: SessionFileStat | null = null;
  for (const f of files) {
    if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
  }
  return newest;
}

/**
 * Display metadata per session file, cached by mtime. The renderer must NEVER
 * fetch full transcripts just to label the list — that shipped megabytes over
 * IPC on every watcher tick and froze the renderer. Only files whose mtime
 * changed (i.e. the actively-streaming session) are re-parsed, in main.
 */
const sessionMetaCache = new Map<
  string,
  {
    mtimeMs: number;
    title: string | null;
    messageCount: number;
    updatedAt: number | string | null;
  }
>();

async function sessionMeta(filePath: string, mtimeMs: number) {
  const cached = sessionMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let meta;
  try {
    // Incremental: parses only the bytes appended since the last call, so the
    // actively-streaming session's growing file isn't fully re-parsed on every
    // watcher tick — just the few new lines.
    const lite = await readSessionMeta(filePath);
    meta = {
      mtimeMs,
      title: lite.title ?? null,
      messageCount: lite.messageCount ?? 0,
      updatedAt: lite.updatedAt ?? mtimeMs,
    };
  } catch {
    meta = cached
      ? { ...cached, mtimeMs }
      : { mtimeMs, title: null, messageCount: 0, updatedAt: mtimeMs };
  }
  sessionMetaCache.set(filePath, meta);
  return meta;
}

// The renderer-facing SessionListEntry adds `archived` and the user-assigned
// `title`, which only main/index.ts can layer on (they live in the
// manual-projects store) — derived structurally so the two can't drift.
export type RawSessionListEntry = Omit<SessionListEntry, "archived" | "title">;

/** All sessions with display metadata, most recently active first. */
export async function listSessions(
  encoded: string,
): Promise<RawSessionListEntry[]> {
  const files = await scanSessionFiles(encoded);
  const out: RawSessionListEntry[] = [];
  for (const f of files) {
    const meta = await sessionMeta(f.filePath, f.mtimeMs);
    out.push({
      sessionId: f.sessionId,
      filePath: f.filePath,
      mtimeMs: f.mtimeMs,
      derivedTitle: meta.title,
      messageCount: meta.messageCount,
      updatedAt: meta.updatedAt,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
