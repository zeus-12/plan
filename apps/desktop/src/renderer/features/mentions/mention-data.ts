import Fuse from "fuse.js";
import type { SkillInfo } from "@/common/shared-types";

/** A file or folder offered by the `@` menu. */
export interface FileEntry {
  kind: "file" | "folder";
  /** Project-relative POSIX path (what serializes to `@path`). */
  path: string;
  /** Last segment, for display + primary fuzzy key. */
  name: string;
}

interface FileIndex {
  entries: FileEntry[];
  fuse: Fuse<FileEntry>;
  at: number;
}

interface SkillIndex {
  skills: SkillInfo[];
  fuse: Fuse<SkillInfo>;
  at: number;
}

// The project file list is large and rarely changes mid-session; cache it per
// project but refresh past a short TTL so newly created files still show up.
const TTL_MS = 10_000;

/** Rows handed to the menu. A fuzzy search over a 20k-file project returns far
 *  more than anyone scrolls, and every extra row is a re-rendered icon per
 *  keystroke — past this you refine the query instead. */
const RESULT_LIMIT = 20;
const fileCache = new Map<string, FileIndex>();
const filePending = new Map<string, Promise<FileIndex>>();
const skillCache = new Map<string, SkillIndex>();
const skillPending = new Map<string, Promise<SkillIndex>>();

async function buildFileIndex(encoded: string): Promise<FileIndex> {
  if (typeof window.electronAPI.listProjectFiles !== "function") {
    console.error("[mentions] listProjectFiles missing — relaunch the app.");
    return { entries: [], fuse: new Fuse<FileEntry>([]), at: Date.now() };
  }
  const files = (await window.electronAPI.listProjectFiles(encoded)) ?? [];
  // Derive every ancestor folder from the flat file list.
  const folders = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"));
  }
  const last = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const entries: FileEntry[] = [
    ...files.map((p): FileEntry => ({ kind: "file", path: p, name: last(p) })),
    ...[...folders].map(
      (p): FileEntry => ({ kind: "folder", path: p, name: last(p) }),
    ),
  ];
  const fuse = new Fuse(entries, {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: "name", weight: 0.7 },
      { name: "path", weight: 0.3 },
    ],
  });
  return { entries, fuse, at: Date.now() };
}

function refreshFileIndex(encoded: string): Promise<FileIndex> {
  let pending = filePending.get(encoded);
  if (!pending) {
    pending = buildFileIndex(encoded)
      .then((idx) => {
        fileCache.set(encoded, idx);
        return idx;
      })
      .finally(() => filePending.delete(encoded));
    filePending.set(encoded, pending);
  }
  return pending;
}

export function loadFileIndex(encoded: string): Promise<FileIndex> {
  const cached = fileCache.get(encoded);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached);
  const pending = refreshFileIndex(encoded);
  // Stale-while-revalidate. Awaiting the rebuild made one keystroke every 10s
  // pay for a full project walk plus a fresh Fuse index; the stale list is a
  // few seconds out of date at worst, and the next keystroke gets the new one.
  return cached ? Promise.resolve(cached) : pending;
}

export function searchFiles(
  idx: FileIndex,
  query: string,
  limit = RESULT_LIMIT,
): FileEntry[] {
  if (!query) {
    // No query yet: files first, then folders, alphabetical — a sane default.
    return idx.entries.slice(0, limit);
  }
  return idx.fuse.search(query, { limit }).map((r) => r.item);
}

async function buildSkillIndex(encoded: string): Promise<SkillIndex> {
  if (typeof window.electronAPI.listSkills !== "function") {
    console.error(
      "[mentions] listSkills missing from preload — fully restart the dev server (main/preload changed).",
    );
    return { skills: [], fuse: new Fuse<SkillInfo>([]), at: Date.now() };
  }
  const skills = (await window.electronAPI.listSkills(encoded)) ?? [];
  const fuse = new Fuse(skills, {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: "name", weight: 0.8 },
      { name: "description", weight: 0.2 },
    ],
  });
  return { skills, fuse, at: Date.now() };
}

function refreshSkillIndex(encoded: string): Promise<SkillIndex> {
  let pending = skillPending.get(encoded);
  if (!pending) {
    pending = buildSkillIndex(encoded)
      .then((idx) => {
        skillCache.set(encoded, idx);
        return idx;
      })
      .finally(() => skillPending.delete(encoded));
    skillPending.set(encoded, pending);
  }
  return pending;
}

export function loadSkillIndex(encoded: string): Promise<SkillIndex> {
  const cached = skillCache.get(encoded);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached);
  const pending = refreshSkillIndex(encoded);
  return cached ? Promise.resolve(cached) : pending;
}

export function searchSkills(
  idx: SkillIndex,
  query: string,
  limit = RESULT_LIMIT,
): SkillInfo[] {
  if (!query) return idx.skills.slice(0, limit);
  return idx.fuse.search(query, { limit }).map((r) => r.item);
}
