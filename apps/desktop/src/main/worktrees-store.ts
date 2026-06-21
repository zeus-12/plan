import { randomUUID } from "crypto";
import { readPlanConfig, writePlanConfig } from "./plan-config";
import type {
  WorktreeRecord,
  WorktreeRepoRecord,
  ProjectDefaults,
} from "../shared-types";

export type { WorktreeRecord, WorktreeRepoRecord, ProjectDefaults };

const CONFIG_NAME = "worktrees.json";

interface Stored {
  worktrees: WorktreeRecord[];
  /** Keyed by projectEncoded. */
  defaults: Record<string, ProjectDefaults>;
}

let cache: Stored | null = null;

function sanitizeRepo(r: unknown): WorktreeRepoRecord | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (
    typeof o.subPath !== "string" ||
    typeof o.path !== "string" ||
    typeof o.branch !== "string" ||
    typeof o.base !== "string"
  )
    return null;
  return { subPath: o.subPath, path: o.path, branch: o.branch, base: o.base };
}

function sanitizeWorktree(w: unknown): WorktreeRecord | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.projectEncoded !== "string" ||
    typeof o.name !== "string" ||
    typeof o.rootPath !== "string" ||
    typeof o.encoded !== "string" ||
    !Array.isArray(o.repos)
  )
    return null;
  const repos = o.repos.map(sanitizeRepo).filter((r): r is WorktreeRepoRecord => !!r);
  return {
    id: o.id,
    projectEncoded: o.projectEncoded,
    name: o.name,
    rootPath: o.rootPath,
    encoded: o.encoded,
    repos,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
  };
}

async function load(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = await readPlanConfig(CONFIG_NAME);
    if (raw === null) throw new Error("no config");
    const parsed = JSON.parse(raw) as Partial<Stored>;
    cache = {
      worktrees: Array.isArray(parsed.worktrees)
        ? parsed.worktrees.map(sanitizeWorktree).filter((w): w is WorktreeRecord => !!w)
        : [],
      defaults:
        parsed.defaults && typeof parsed.defaults === "object"
          ? (parsed.defaults as Record<string, ProjectDefaults>)
          : {},
    };
  } catch {
    cache = { worktrees: [], defaults: {} };
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
      // best-effort persistence
    }
  }, 300);
}

export async function listWorktreeRecords(
  projectEncoded: string
): Promise<WorktreeRecord[]> {
  const data = await load();
  return data.worktrees.filter((w) => w.projectEncoded === projectEncoded);
}

export async function getWorktreeRecord(
  id: string
): Promise<WorktreeRecord | null> {
  const data = await load();
  return data.worktrees.find((w) => w.id === id) ?? null;
}

export async function addWorktreeRecord(
  rec: Omit<WorktreeRecord, "id" | "createdAt">
): Promise<WorktreeRecord> {
  const data = await load();
  const full: WorktreeRecord = { ...rec, id: randomUUID(), createdAt: Date.now() };
  data.worktrees.push(full);
  scheduleWrite();
  return full;
}

export async function deleteWorktreeRecord(id: string): Promise<void> {
  const data = await load();
  const next = data.worktrees.filter((w) => w.id !== id);
  if (next.length !== data.worktrees.length) {
    data.worktrees = next;
    scheduleWrite();
  }
}

/** True when a worktree with this name already exists for the project. */
export async function worktreeNameTaken(
  projectEncoded: string,
  name: string
): Promise<boolean> {
  const data = await load();
  return data.worktrees.some(
    (w) => w.projectEncoded === projectEncoded && w.name === name
  );
}

export async function getProjectDefaults(
  projectEncoded: string
): Promise<ProjectDefaults> {
  const data = await load();
  return data.defaults[projectEncoded] ?? {};
}

export async function setProjectDefaults(
  projectEncoded: string,
  defaults: ProjectDefaults
): Promise<void> {
  const data = await load();
  data.defaults[projectEncoded] = defaults;
  scheduleWrite();
}
