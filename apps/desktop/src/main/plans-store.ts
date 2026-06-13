import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const DEFAULT_PATH = join(homedir(), ".claude", "plan-desktop-plans.json");

export interface PlanVersion {
  id: string;
  text: string;
  createdAt: number;
}

export interface Plan {
  filePath: string;
  versions: PlanVersion[];
  /** Count of new/changed events since the user last opened this plan. */
  unread: number;
  /** Last modified time of the file (or last event ts) — for sort order. */
  updatedAt: number;
  /** Hidden from the active list until unarchived. */
  archived: boolean;
}

interface Stored {
  plans: Plan[];
}

let cache: Stored | null = null;
let storePath = DEFAULT_PATH;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Used by tests to redirect the persistence file. */
export function _setStorePathForTest(path: string) {
  storePath = path;
  cache = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

export async function loadPlans(): Promise<Plan[]> {
  if (cache) return cache.plans;
  try {
    const raw = await readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const plans = Array.isArray(parsed.plans) ? parsed.plans : [];
    // Older stored plans predate `archived` — normalize them to false.
    cache = {
      plans: plans
        .filter(isValidPlan)
        .map((p) => ({ ...p, archived: p.archived ?? false })),
    };
  } catch {
    cache = { plans: [] };
  }
  return cache.plans;
}

function isValidPlan(p: unknown): p is Plan {
  if (!p || typeof p !== "object") return false;
  const pp = p as Plan;
  return (
    typeof pp.filePath === "string" &&
    Array.isArray(pp.versions) &&
    typeof pp.unread === "number"
  );
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (!cache) return;
    try {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(storePath, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // best-effort persistence
    }
  }, 300);
}

export async function flushWrites(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cache) return;
  try {
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

/** Note: callers should `await loadPlans()` first. */
export function getPlans(): Plan[] {
  return cache?.plans ?? [];
}

export function getPlan(filePath: string): Plan | undefined {
  return getPlans().find((p) => p.filePath === filePath);
}

export function recordNewPlan(filePath: string, content: string, ts = Date.now()): Plan {
  if (!cache) cache = { plans: [] };
  const existing = cache.plans.find((p) => p.filePath === filePath);
  const version: PlanVersion = {
    id: randomUUID(),
    text: content,
    createdAt: ts,
  };
  if (existing) {
    // Already known — treat as a change event (e.g. parallel watcher race).
    return recordPlanChange(filePath, content, ts);
  }
  const plan: Plan = {
    filePath,
    versions: [version],
    unread: 1,
    updatedAt: ts,
    archived: false,
  };
  cache.plans.push(plan);
  scheduleWrite();
  return plan;
}

export function recordPlanChange(
  filePath: string,
  content: string,
  ts = Date.now()
): Plan {
  if (!cache) cache = { plans: [] };
  let plan = cache.plans.find((p) => p.filePath === filePath);
  if (!plan) {
    plan = {
      filePath,
      versions: [],
      unread: 0,
      updatedAt: ts,
      archived: false,
    };
    cache.plans.push(plan);
  }
  const last = plan.versions[plan.versions.length - 1];
  if (last && last.text === content) {
    // identical content — no new version
    plan.updatedAt = ts;
    scheduleWrite();
    return plan;
  }
  plan.versions.push({ id: randomUUID(), text: content, createdAt: ts });
  plan.unread += 1;
  plan.updatedAt = ts;
  scheduleWrite();
  return plan;
}

export function removePlan(filePath: string): void {
  if (!cache) return;
  const before = cache.plans.length;
  cache.plans = cache.plans.filter((p) => p.filePath !== filePath);
  if (cache.plans.length !== before) scheduleWrite();
}

export function markPlanRead(filePath: string): void {
  if (!cache) return;
  const plan = cache.plans.find((p) => p.filePath === filePath);
  if (!plan || plan.unread === 0) return;
  plan.unread = 0;
  scheduleWrite();
}

export function setPlanArchived(filePath: string, archived: boolean): void {
  if (!cache) return;
  const plan = cache.plans.find((p) => p.filePath === filePath);
  if (!plan || plan.archived === archived) return;
  plan.archived = archived;
  scheduleWrite();
}
