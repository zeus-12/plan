import { watch, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, listSessionFiles } from "./claude-sessions";
import { clearRelocationGuards, reapRelocatedStub } from "./session-reaper";
import type { SessionEvent } from "../shared-types";

const DEBOUNCE_MS = 300;

export type { SessionEvent };

export interface WatcherCallbacks {
  onEvent: (e: SessionEvent) => void;
}

interface ActiveWatch {
  abort: AbortController;
  knownFiles: Set<string>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const projectWatchers = new Map<string, ActiveWatch>();
let rootWatch: { abort: AbortController } | null = null;
let callbacks: WatcherCallbacks | null = null;

export function setCallbacks(cb: WatcherCallbacks) {
  callbacks = cb;
}

export async function startWatching(encoded: string): Promise<void> {
  if (projectWatchers.has(encoded)) return;

  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  const abort = new AbortController();
  const knownFiles = new Set<string>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  projectWatchers.set(encoded, { abort, knownFiles, debounceTimers });

  for (const f of await listSessionFiles(encoded)) {
    knownFiles.add(f.filePath);
  }

  void runProjectWatch(encoded, dir, abort.signal, knownFiles, debounceTimers);
}

export function stopWatching(encoded: string): void {
  const a = projectWatchers.get(encoded);
  if (!a) return;
  a.abort.abort();
  for (const t of a.debounceTimers.values()) clearTimeout(t);
  projectWatchers.delete(encoded);
}

export function stopAll(): void {
  for (const enc of [...projectWatchers.keys()]) stopWatching(enc);
  rootWatch?.abort.abort();
  rootWatch = null;
  clearRelocationGuards();
}

async function runProjectWatch(
  encoded: string,
  dir: string,
  signal: AbortSignal,
  knownFiles: Set<string>,
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>,
) {
  try {
    const watcher = watch(dir, { signal, recursive: false });
    for await (const event of watcher) {
      if (!event.filename || !event.filename.endsWith(".jsonl")) continue;

      const filePath = join(dir, event.filename);

      const existing = debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        filePath,
        setTimeout(async () => {
          debounceTimers.delete(filePath);
          try {
            const s = await stat(filePath);
            if (!s.isFile()) return;
          } catch {
            return;
          }

          const sessionId = event.filename!.replace(/\.jsonl$/, "");

          // A session moved out of this project can leave a message-less ghost
          // here if the source `claude` flushes state after the transcript was
          // renamed away. Reap it instead of surfacing it (see session-reaper).
          if (await reapRelocatedStub(encoded, sessionId, filePath)) {
            knownFiles.delete(filePath);
            return;
          }

          const wasKnown = knownFiles.has(filePath);
          knownFiles.add(filePath);

          if (!callbacks) return;
          callbacks.onEvent({
            kind: wasKnown ? "session-changed" : "new-session",
            encoded,
            sessionId,
            filePath,
          });
        }, DEBOUNCE_MS),
      );
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
  }
}

/**
 * Watch the projects root dir itself for new project directories. When one
 * appears we begin watching it for sessions.
 */
export async function startRootWatch(): Promise<void> {
  if (rootWatch) return;
  const abort = new AbortController();
  rootWatch = { abort };
  void runRootWatch(abort.signal);
}

async function runRootWatch(signal: AbortSignal) {
  try {
    const watcher = watch(CLAUDE_PROJECTS_DIR, { signal, recursive: false });
    for await (const event of watcher) {
      if (!event.filename) continue;
      const encoded = event.filename;
      const fullPath = join(CLAUDE_PROJECTS_DIR, encoded);
      try {
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      if (projectWatchers.has(encoded)) continue;
      await startWatching(encoded);
      callbacks?.onEvent({ kind: "project-added", encoded });
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
  }
}
