import { watch, readdir, readFile, stat, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PLANS_DIR = join(homedir(), ".claude", "plans");
const DEBOUNCE_MS = 1000;

interface WatcherCallbacks {
  onNewFile: (filePath: string, content: string) => void;
  onFileChanged: (filePath: string, content: string) => void;
}

let currentWatcher: { abort: AbortController } | null = null;
const knownFiles = new Map<string, string>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function startDirectoryWatcher(
  callbacks: WatcherCallbacks,
  dir: string = PLANS_DIR
) {
  stopWatching();
  knownFiles.clear();

  await mkdir(dir, { recursive: true });

  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isFile()) {
          const content = await readFile(fullPath, "utf-8");
          knownFiles.set(fullPath, content);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory listing failed, proceed with empty snapshot
  }

  const abort = new AbortController();
  currentWatcher = { abort };

  watchDirectory(dir, abort.signal, callbacks);
}

export function stopWatching() {
  if (currentWatcher) {
    currentWatcher.abort.abort();
    currentWatcher = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  knownFiles.clear();
}

async function watchDirectory(
  dir: string,
  signal: AbortSignal,
  callbacks: WatcherCallbacks
) {
  try {
    const watcher = watch(dir, { signal, recursive: false });

    for await (const event of watcher) {
      if (!event.filename) continue;

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

            const content = await readFile(filePath, "utf-8");
            const previousContent = knownFiles.get(filePath);

            if (previousContent === undefined) {
              knownFiles.set(filePath, content);
              callbacks.onNewFile(filePath, content);
            } else if (content !== previousContent) {
              knownFiles.set(filePath, content);
              callbacks.onFileChanged(filePath, content);
            }
          } catch {
            // file might be mid-write or deleted
          }
        }, DEBOUNCE_MS)
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  }
}
