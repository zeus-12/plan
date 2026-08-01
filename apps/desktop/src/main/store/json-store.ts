import { readPlanConfig, writePlanConfig } from "./plan-config";

/**
 * A cached JSON document under `~/.plan/<name>`, shared by every main-process
 * store (projects.json, worktrees.json). Owns the persistence policy in one
 * place: first read hydrates a module-lifetime cache through `sanitize` (which
 * must also produce defaults from `null` — missing or corrupt file), and
 * writes are debounced 300ms, best-effort (a failed write keeps the in-memory
 * value for this run).
 *
 * Callers mutate the object `load()` returns and call `scheduleWrite()` —
 * same contract the stores had individually, now with one implementation.
 */
export function createJsonStore<T>(
  name: string,
  sanitize: (raw: unknown) => T,
): {
  load: () => Promise<T>;
  scheduleWrite: () => void;
} {
  let cache: T | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<T> {
    if (cache !== null) return cache;
    try {
      const raw = await readPlanConfig(name);
      cache = sanitize(raw === null ? null : JSON.parse(raw));
    } catch {
      cache = sanitize(null);
    }
    return cache;
  }

  function scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      if (cache === null) return;
      try {
        await writePlanConfig(name, JSON.stringify(cache, null, 2));
      } catch {
        // best-effort persistence
      }
    }, 300);
  }

  return { load, scheduleWrite };
}
