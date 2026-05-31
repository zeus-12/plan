import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

const PATH = join(homedir(), ".claude", "plan-desktop.json");

interface Stored {
  manualCwds: string[];
  archivedEncoded: string[];
}

let cache: Stored | null = null;

async function load(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = await readFile(PATH, "utf-8");
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
    };
  } catch {
    cache = { manualCwds: [], archivedEncoded: [] };
  }
  return cache;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    if (!cache) return;
    try {
      await mkdir(dirname(PATH), { recursive: true });
      await writeFile(PATH, JSON.stringify(cache, null, 2), "utf-8");
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

/** Claude's encoding: replace path separators with hyphens. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}
