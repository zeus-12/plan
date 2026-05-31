import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  startPlansWatcher,
  stopPlansWatcher,
} from "../src/main/plans-watcher";

// macOS fs.watch needs a beat to bind and to deliver events
const WATCHER_SETTLE_MS = 200;
const DEBOUNCE_MARGIN_MS = 500;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Event {
  kind: "new" | "changed" | "removed";
  filePath: string;
  content?: string;
}

describe("plans watcher", () => {
  let dir: string;
  const events: Event[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "plan-test-"));
    events.length = 0;
  });

  afterEach(async () => {
    await stopPlansWatcher();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("emits new-file when a markdown file is created", async () => {
    await startPlansWatcher(
      {
        onNewFile: (filePath, content) =>
          events.push({ kind: "new", filePath, content }),
        onFileChanged: (filePath, content) =>
          events.push({ kind: "changed", filePath, content }),
        onFileRemoved: (filePath) =>
          events.push({ kind: "removed", filePath }),
      },
      dir
    );

    await sleep(WATCHER_SETTLE_MS);

    const file = join(dir, "plan.md");
    await writeFile(file, "# Hello", "utf-8");

    await waitFor(() => events.some((e) => e.kind === "new"));
    const newEvent = events.find((e) => e.kind === "new")!;
    expect(newEvent.filePath).toBe(file);
    expect(newEvent.content).toBe("# Hello");
  });

  it("emits file-changed when content changes", async () => {
    const file = join(dir, "plan.md");
    await writeFile(file, "v1", "utf-8");

    // Seed the watcher with the file already present so it counts as known.
    await startPlansWatcher(
      {
        onNewFile: (filePath, content) =>
          events.push({ kind: "new", filePath, content }),
        onFileChanged: (filePath, content) =>
          events.push({ kind: "changed", filePath, content }),
        onFileRemoved: (filePath) =>
          events.push({ kind: "removed", filePath }),
      },
      dir
    );

    await sleep(WATCHER_SETTLE_MS);
    await writeFile(file, "v2", "utf-8");

    await waitFor(
      () =>
        events.some((e) => e.kind === "changed" && e.content === "v2"),
      WATCHER_SETTLE_MS + DEBOUNCE_MARGIN_MS + 4000
    );
    expect(events.some((e) => e.kind === "new")).toBe(false);
  });

  it("ignores non-plan files", async () => {
    await startPlansWatcher(
      {
        onNewFile: (filePath, content) =>
          events.push({ kind: "new", filePath, content }),
        onFileChanged: () => {},
      },
      dir
    );
    await sleep(WATCHER_SETTLE_MS);

    await writeFile(join(dir, "not-a-plan.json"), "{}", "utf-8");
    await writeFile(join(dir, "plan.md"), "ok", "utf-8");

    await waitFor(() => events.some((e) => e.kind === "new"));
    // Only the markdown file should have surfaced
    expect(events).toHaveLength(1);
    expect(events[0].filePath.endsWith(".md")).toBe(true);
  });
});
