import { randomUUID } from "crypto";
import { createJsonStore } from "@/main/store/json-store";
import type {
  ManagedWorktreeRecord,
  WorktreeRepoRecord,
  ProjectDefaults,
} from "@/common/shared-types";

export type {
  ManagedWorktreeRecord,
  WorktreeRepoRecord,
  ProjectDefaults,
} from "@/common/shared-types";

/**
 * What actually lives in `worktrees.json`. `mtimeMs` is read off the session
 * transcripts on demand, so keeping it out of the persisted shape means a stale
 * copy can never be written back or trusted on load.
 */
export type StoredWorktree = Omit<ManagedWorktreeRecord, "mtimeMs">;

interface Stored {
  worktrees: StoredWorktree[];
  /** Keyed by projectEncoded. */
  defaults: Record<string, ProjectDefaults>;
  /**
   * User-assigned display names, keyed by the worktree's canonical rootPath so
   * one map covers managed and external alike. Keyed by path rather than id
   * because an external worktree's id is derived from the project it was found
   * under, which changes when that project is removed and re-added.
   */
  names: Record<string, string>;
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
    kind: "managed",
    id: o.id,
    projectEncoded: o.projectEncoded,
    name: o.name,
    rootPath: o.rootPath,
    encoded: o.encoded,
    repos,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
  };
}

function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
    ),
  );
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
      names: stringRecord(parsed.names),
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
  rec: Omit<StoredWorktree, "kind" | "id" | "createdAt">,
): Promise<StoredWorktree> {
  const data = await load();
  const full: StoredWorktree = {
    kind: "managed",
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

/** Display-name overrides for every worktree, keyed by canonical rootPath. */
export async function getWorktreeNames(): Promise<Record<string, string>> {
  const data = await load();
  return data.names;
}

/**
 * Set (or, with an empty name, clear) a worktree's display name. Only the label
 * moves — the stored `name` still backs the checkout directory and the branch,
 * so renaming can never strand a checkout or its chats.
 */
export async function setWorktreeName(
  rootPath: string,
  name: string,
): Promise<void> {
  const data = await load();
  const trimmed = name.trim();
  if (trimmed) data.names[rootPath] = trimmed;
  else delete data.names[rootPath];
  scheduleWrite();
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
