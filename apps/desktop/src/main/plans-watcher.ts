import { watch, readdir, readFile, stat, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_PLANS_DIR = join(homedir(), ".claude", "plans");
const DEBOUNCE_MS = 250;

export interface PlanWatcherCallbacks {
  onNewFile: (filePath: string, content: string) => void;
  onFileChanged: (filePath: string, content: string) => void;
  onFileRemoved?: (filePath: string) => void;
}

interface State {
  abort: AbortController;
  knownContent: Map<string, string>;
  debounce: Map<string, ReturnType<typeof setTimeout>>;
}

let state: State | null = null;

/**
 * Watch a directory for plan files. New `.md`/`.txt` files fire onNewFile;
 * existing files whose content changes fire onFileChanged. Debounced so a
 * burst of writes during an editor save settles into one event.
 *
 * Returns the directory actually being watched (handy for tests).
 */
export async function startPlansWatcher(
  callbacks: PlanWatcherCallbacks,
  dir: string = DEFAULT_PLANS_DIR
): Promise<string> {
  await stopPlansWatcher();

  await mkdir(dir, { recursive: true });

  const knownContent = new Map<string, string>();
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!isPlanFile(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (!s.isFile()) continue;
        const content = await readFile(fullPath, "utf-8");
        knownContent.set(fullPath, content);
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // directory listing failed, proceed with empty snapshot
  }

  const abort = new AbortController();
  state = { abort, knownContent, debounce: new Map() };
  void runWatch(dir, abort.signal, callbacks);

  return dir;
}

export async function stopPlansWatcher(): Promise<void> {
  if (!state) return;
  state.abort.abort();
  for (const t of state.debounce.values()) clearTimeout(t);
  state = null;
}

/** Snapshot of currently-known plans (path → content). Used to seed the UI. */
export function snapshotKnown(): Map<string, string> {
  return new Map(state?.knownContent ?? []);
}

function isPlanFile(name: string): boolean {
  return name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".markdown");
}

async function runWatch(
  dir: string,
  signal: AbortSignal,
  callbacks: PlanWatcherCallbacks
) {
  try {
    const watcher = watch(dir, { signal, recursive: false });
    for await (const event of watcher) {
      if (!event.filename || !isPlanFile(event.filename)) continue;
      const filePath = join(dir, event.filename);
      handleEvent(filePath, callbacks);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    // swallow — watcher just stops on other errors
  }
}

function handleEvent(filePath: string, callbacks: PlanWatcherCallbacks) {
  const s = state;
  if (!s) return;
  const existing = s.debounce.get(filePath);
  if (existing) clearTimeout(existing);
  s.debounce.set(
    filePath,
    setTimeout(async () => {
      s.debounce.delete(filePath);
      let exists = true;
      let content = "";
      try {
        const st = await stat(filePath);
        if (!st.isFile()) exists = false;
        else content = await readFile(filePath, "utf-8");
      } catch {
        exists = false;
      }

      const previous = s.knownContent.get(filePath);

      if (!exists) {
        if (previous !== undefined) {
          s.knownContent.delete(filePath);
          callbacks.onFileRemoved?.(filePath);
        }
        return;
      }

      if (previous === undefined) {
        s.knownContent.set(filePath, content);
        callbacks.onNewFile(filePath, content);
      } else if (previous !== content) {
        s.knownContent.set(filePath, content);
        callbacks.onFileChanged(filePath, content);
      }
    }, DEBOUNCE_MS)
  );
}
