import { readPlanConfig, writePlanConfig } from "./plan-config";
import { primeProjectCwd } from "./claude-projects";

const CONFIG_NAME = "projects.json";

interface Stored {
  manualCwds: string[];
  archivedEncoded: string[];
  /** Archived chat session ids (UUIDs are globally unique, so no project scope). */
  archivedSessions: string[];
  /** User-assigned display names per session id (overrides the derived title). */
  sessionNames: Record<string, string>;
}

let cache: Stored | null = null;

async function load(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = await readPlanConfig(CONFIG_NAME);
    if (raw === null) throw new Error("no config");
    const parsed = JSON.parse(raw) as Partial<Stored>;
    cache = {
      manualCwds: Array.isArray(parsed.manualCwds)
        ? parsed.manualCwds.filter((x): x is string => typeof x === "string")
        : [],
      archivedEncoded: Array.isArray(parsed.archivedEncoded)
        ? parsed.archivedEncoded.filter(
            (x): x is string => typeof x === "string"
          )
        : [],
      archivedSessions: Array.isArray(parsed.archivedSessions)
        ? parsed.archivedSessions.filter(
            (x): x is string => typeof x === "string"
          )
        : [],
      sessionNames:
        parsed.sessionNames && typeof parsed.sessionNames === "object"
          ? Object.fromEntries(
              Object.entries(parsed.sessionNames).filter(
                ([, v]) => typeof v === "string"
              )
            )
          : {},
    };
  } catch {
    cache = {
      manualCwds: [],
      archivedEncoded: [],
      archivedSessions: [],
      sessionNames: {},
    };
  }
  return cache;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    if (!cache) return;
    try {
      await writePlanConfig(CONFIG_NAME, JSON.stringify(cache, null, 2));
    } catch {
      // ignore — best-effort persistence
    }
  }, 300);
}

export async function getManualCwds(): Promise<string[]> {
  const data = await load();
  return [...data.manualCwds];
}

export async function addManualCwd(cwd: string): Promise<void> {
  const data = await load();
  // The picked folder is the authoritative project root — seed it so the very
  // first terminal/file request resolves to it instead of session history.
  primeProjectCwd(encodeCwd(cwd), cwd);
  if (!data.manualCwds.includes(cwd)) {
    data.manualCwds.push(cwd);
    scheduleWrite();
  }
}

export async function removeManualCwd(cwd: string): Promise<void> {
  const data = await load();
  const next = data.manualCwds.filter((c) => c !== cwd);
  if (next.length !== data.manualCwds.length) {
    data.manualCwds = next;
    scheduleWrite();
  }
}

export async function getArchivedEncoded(): Promise<string[]> {
  const data = await load();
  return [...data.archivedEncoded];
}

export async function setArchived(encoded: string, archived: boolean) {
  const data = await load();
  const has = data.archivedEncoded.includes(encoded);
  if (archived && !has) {
    data.archivedEncoded.push(encoded);
    scheduleWrite();
  } else if (!archived && has) {
    data.archivedEncoded = data.archivedEncoded.filter((e) => e !== encoded);
    scheduleWrite();
  }
}

export async function getArchivedSessions(): Promise<string[]> {
  const data = await load();
  return [...data.archivedSessions];
}

export async function setSessionArchived(
  sessionId: string,
  archived: boolean
) {
  const data = await load();
  const has = data.archivedSessions.includes(sessionId);
  if (archived && !has) {
    data.archivedSessions.push(sessionId);
    scheduleWrite();
  } else if (!archived && has) {
    data.archivedSessions = data.archivedSessions.filter(
      (s) => s !== sessionId
    );
    scheduleWrite();
  }
}

export async function getSessionNames(): Promise<Record<string, string>> {
  const data = await load();
  return { ...data.sessionNames };
}

/** Set a custom display name; an empty name clears it (back to derived title). */
export async function setSessionName(sessionId: string, name: string) {
  const data = await load();
  const trimmed = name.trim();
  if (trimmed) {
    if (data.sessionNames[sessionId] === trimmed) return;
    data.sessionNames[sessionId] = trimmed;
  } else {
    if (!(sessionId in data.sessionNames)) return;
    delete data.sessionNames[sessionId];
  }
  scheduleWrite();
}

/**
 * Claude's encoding: replace every non-alphanumeric character with a hyphen.
 * This covers path separators as well as spaces, dots, parens, etc. — e.g.
 * "/Users/x/hacker rank ats" → "-Users-x-hacker-rank-ats" and
 * "/Users/x/copilot (ic)" → "-Users-x-copilot--ic-". Must match the directory
 * names Claude creates under ~/.claude/projects, or session lookups miss.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
