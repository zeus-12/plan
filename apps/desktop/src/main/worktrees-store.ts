import { randomUUID } from "crypto";
import { createJsonStore } from "./json-store";
import type {
  WorktreeRecord,
  WorktreeRepoRecord,
  ProjectDefaults,
} from "../shared-types";

export type { WorktreeRecord, WorktreeRepoRecord, ProjectDefaults };

/**
 * What actually lives in `worktrees.json`. `mtimeMs` is read off the session
 * transcripts on demand, so keeping it out of the persisted shape means a stale
 * copy can never be written back or trusted on load.
 */
export type StoredWorktree = Omit<WorktreeRecord, "mtimeMs">;

interface Stored {
  worktrees: StoredWorktree[];
  /** Keyed by projectEncoded. */
  defaults: Record<string, ProjectDefaults>;
}

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

function sanitizeWorktree(w: unknown): StoredWorktree | null {
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
  const repos = o.repos
    .map(sanitizeRepo)
    .filter((r): r is WorktreeRepoRecord => !!r);
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

const { load, scheduleWrite } = createJsonStore<Stored>(
  "worktrees.json",
  (raw) => {
    const parsed = (
      raw && typeof raw === "object" ? raw : {}
    ) as Partial<Stored>;
    return {
      worktrees: Array.isArray(parsed.worktrees)
        ? parsed.worktrees
            .map(sanitizeWorktree)
            .filter((w): w is StoredWorktree => !!w)
        : [],
      defaults:
        parsed.defaults && typeof parsed.defaults === "object"
          ? (parsed.defaults as Record<string, ProjectDefaults>)
          : {},
    };
  },
);

export async function listWorktreeRecords(
  projectEncoded: string,
): Promise<StoredWorktree[]> {
  const data = await load();
  return data.worktrees.filter((w) => w.projectEncoded === projectEncoded);
}

export async function listAllWorktreeRecords(): Promise<StoredWorktree[]> {
  const data = await load();
  return [...data.worktrees];
}

export async function getWorktreeRecord(
  id: string,
): Promise<StoredWorktree | null> {
  const data = await load();
  return data.worktrees.find((w) => w.id === id) ?? null;
}

export async function addWorktreeRecord(
  rec: Omit<StoredWorktree, "id" | "createdAt">,
): Promise<StoredWorktree> {
  const data = await load();
  const full: StoredWorktree = {
    ...rec,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  data.worktrees.push(full);
  scheduleWrite();
  return full;
}

/** Replace a worktree record in place (e.g. after adding repos to it). */
export async function updateWorktreeRecord(rec: StoredWorktree): Promise<void> {
  const data = await load();
  const idx = data.worktrees.findIndex((w) => w.id === rec.id);
  if (idx === -1) return;
  data.worktrees[idx] = rec;
  scheduleWrite();
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
  name: string,
): Promise<boolean> {
  const data = await load();
  return data.worktrees.some(
    (w) => w.projectEncoded === projectEncoded && w.name === name,
  );
}

export async function getProjectDefaults(
  projectEncoded: string,
): Promise<ProjectDefaults> {
  const data = await load();
  return data.defaults[projectEncoded] ?? {};
}

export async function setProjectDefaults(
  projectEncoded: string,
  defaults: ProjectDefaults,
): Promise<void> {
  const data = await load();
  data.defaults[projectEncoded] = defaults;
  scheduleWrite();
}
