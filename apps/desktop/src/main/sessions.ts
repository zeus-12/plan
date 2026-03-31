import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

const DEFAULT_SESSIONS_PATH = join(homedir(), ".claude", "plan-sessions.json");

export interface SessionVersion {
  id: string;
  text: string;
  annotations: Array<{
    id: string;
    selectedText: string;
    startOffset: number;
    endOffset: number;
    comment: string;
    side: "left" | "right";
  }>;
  createdAt: number;
}

export interface Session {
  filePath: string;
  versions: SessionVersion[];
}

let sessionsPath = DEFAULT_SESSIONS_PATH;
let sessions: Session[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;

async function writeToDisk() {
  try {
    await mkdir(dirname(sessionsPath), { recursive: true });
    await writeFile(sessionsPath, JSON.stringify(sessions, null, 2), "utf-8");
  } catch {
    // ignore write errors
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeToDisk, 500);
}

export function _setSessionsPathForTest(path: string) {
  sessionsPath = path;
  sessions = [];
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

export async function flushWrites() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    await writeToDisk();
  }
}

export async function loadSessions(): Promise<Session[]> {
  try {
    const raw = await readFile(sessionsPath, "utf-8");
    sessions = JSON.parse(raw);
    return sessions;
  } catch {
    sessions = [];
    return sessions;
  }
}

export function getSession(filePath: string): Session | undefined {
  return sessions.find((s) => s.filePath === filePath);
}

export function saveSession(filePath: string, versions: SessionVersion[]) {
  const idx = sessions.findIndex((s) => s.filePath === filePath);
  if (idx >= 0) {
    sessions[idx] = { filePath, versions };
  } else {
    sessions.push({ filePath, versions });
  }
  scheduleWrite();
}

export function removeSession(filePath: string) {
  sessions = sessions.filter((s) => s.filePath !== filePath);
  scheduleWrite();
}
