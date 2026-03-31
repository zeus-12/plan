import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { startDirectoryWatcher, stopWatching } from "../src/main/watcher";
import {
  loadSessions,
  saveSession,
  getSession,
  flushWrites,
  _setSessionsPathForTest,
  type SessionVersion,
} from "../src/main/sessions";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// fs.watch needs a moment to establish on macOS
const WATCHER_SETTLE_MS = 200;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface WatcherEvent {
  type: "new" | "changed";
  filePath: string;
  content: string;
}

// -------------------------------------------------------------------
// Watcher tests — create/edit real markdown files, verify detection
// -------------------------------------------------------------------

describe("watcher: detects file events in a directory", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "plan-watcher-"));
  });

  afterEach(async () => {
    stopWatching();
    await rm(testDir, { recursive: true, force: true });
  });

  it("calls onNewFile when a .md file is created", async () => {
    const events: WatcherEvent[] = [];

    await startDirectoryWatcher(
      {
        onNewFile(filePath, content) {
          events.push({ type: "new", filePath, content });
        },
        onFileChanged(filePath, content) {
          events.push({ type: "changed", filePath, content });
        },
      },
      testDir
    );
    await wait(WATCHER_SETTLE_MS);

    await writeFile(join(testDir, "plan-a.md"), "# Plan A\n\nDo the thing.");
    await waitFor(() => events.length >= 1);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("new");
    expect(events[0].filePath).toBe(join(testDir, "plan-a.md"));
    expect(events[0].content).toBe("# Plan A\n\nDo the thing.");
  });

  it("calls onFileChanged when an existing file is edited", async () => {
    // Pre-create file so it's in the snapshot
    await writeFile(join(testDir, "existing.md"), "# v1");

    const events: WatcherEvent[] = [];

    await startDirectoryWatcher(
      {
        onNewFile(filePath, content) {
          events.push({ type: "new", filePath, content });
        },
        onFileChanged(filePath, content) {
          events.push({ type: "changed", filePath, content });
        },
      },
      testDir
    );
    await wait(WATCHER_SETTLE_MS);

    // Edit the file
    await writeFile(join(testDir, "existing.md"), "# v2\n\nUpdated.");
    await waitFor(() => events.length >= 1);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("changed");
    expect(events[0].content).toBe("# v2\n\nUpdated.");
  });

  it("handles multiple new files independently", async () => {
    const events: WatcherEvent[] = [];

    await startDirectoryWatcher(
      {
        onNewFile(filePath, content) {
          events.push({ type: "new", filePath, content });
        },
        onFileChanged(filePath, content) {
          events.push({ type: "changed", filePath, content });
        },
      },
      testDir
    );
    await wait(WATCHER_SETTLE_MS);

    await writeFile(join(testDir, "file-1.md"), "first");
    await waitFor(() => events.length >= 1);

    await writeFile(join(testDir, "file-2.md"), "second");
    await waitFor(() => events.length >= 2);

    const newEvents = events.filter((e) => e.type === "new");
    expect(newEvents).toHaveLength(2);
    expect(newEvents.map((e) => e.content).sort()).toEqual(["first", "second"]);
  });

  it("ignores a write with identical content", async () => {
    await writeFile(join(testDir, "same.md"), "unchanged");

    const events: WatcherEvent[] = [];

    await startDirectoryWatcher(
      {
        onNewFile(filePath, content) {
          events.push({ type: "new", filePath, content });
        },
        onFileChanged(filePath, content) {
          events.push({ type: "changed", filePath, content });
        },
      },
      testDir
    );
    await wait(WATCHER_SETTLE_MS);

    // Write same content
    await writeFile(join(testDir, "same.md"), "unchanged");
    // Wait past debounce — should not fire
    await wait(1500);

    expect(events).toHaveLength(0);
  });
});

// -------------------------------------------------------------------
// Session persistence tests
// -------------------------------------------------------------------

describe("sessions: save, load, and restore", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "plan-sessions-"));
    _setSessionsPathForTest(join(testDir, "sessions.json"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeVersion(text: string): SessionVersion {
    return {
      id: crypto.randomUUID(),
      text,
      annotations: [],
      createdAt: Date.now(),
    };
  }

  it("saves a session and retrieves it with getSession", () => {
    const v1 = makeVersion("# Plan\n\nStep 1");
    saveSession("/tmp/plan.md", [v1]);

    const session = getSession("/tmp/plan.md");
    expect(session).toBeDefined();
    expect(session!.versions).toHaveLength(1);
    expect(session!.versions[0].text).toBe("# Plan\n\nStep 1");
  });

  it("persists sessions to disk and reloads them", async () => {
    const v1 = makeVersion("v1 content");
    const v2 = makeVersion("v2 content");
    saveSession("/tmp/a.md", [v1, v2]);
    saveSession("/tmp/b.md", [makeVersion("b content")]);

    await flushWrites();

    // Reset in-memory state
    _setSessionsPathForTest(join(testDir, "sessions.json"));

    const loaded = await loadSessions();
    expect(loaded).toHaveLength(2);

    const sessionA = loaded.find((s) => s.filePath === "/tmp/a.md");
    expect(sessionA).toBeDefined();
    expect(sessionA!.versions).toHaveLength(2);
    expect(sessionA!.versions[0].text).toBe("v1 content");
    expect(sessionA!.versions[1].text).toBe("v2 content");
  });

  it("upserts: saving an existing session replaces it", () => {
    saveSession("/tmp/plan.md", [makeVersion("old")]);
    saveSession("/tmp/plan.md", [makeVersion("old"), makeVersion("new")]);

    const session = getSession("/tmp/plan.md");
    expect(session!.versions).toHaveLength(2);
    expect(session!.versions[1].text).toBe("new");
  });

  it("loadSessions returns empty array when no file exists", async () => {
    _setSessionsPathForTest(join(testDir, "nonexistent.json"));
    const loaded = await loadSessions();
    expect(loaded).toEqual([]);
  });
});

// -------------------------------------------------------------------
// Integration: watcher + sessions simulate app window management
// -------------------------------------------------------------------

describe("integration: file events → window tracking + session persistence", () => {
  let testDir: string;
  let sessionsDir: string;

  // Simulates the main process windowMap
  const windows = new Map<
    string,
    { filePath: string; contentUpdates: string[] }
  >();

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "plan-integration-"));
    sessionsDir = await mkdtemp(join(tmpdir(), "plan-int-sessions-"));
    _setSessionsPathForTest(join(sessionsDir, "sessions.json"));
    windows.clear();
  });

  afterEach(async () => {
    stopWatching();
    await rm(testDir, { recursive: true, force: true });
    await rm(sessionsDir, { recursive: true, force: true });
  });

  async function startSimulatedApp() {
    // Mirrors the logic in apps/desktop/src/main/index.ts
    await startDirectoryWatcher(
      {
        onNewFile(filePath, content) {
          const version: SessionVersion = {
            id: crypto.randomUUID(),
            text: content,
            annotations: [],
            createdAt: Date.now(),
          };
          saveSession(filePath, [version]);
          // "Open a window"
          windows.set(filePath, { filePath, contentUpdates: [] });
        },
        onFileChanged(filePath, content) {
          const win = windows.get(filePath);
          if (win) {
            // "Send content to existing window"
            win.contentUpdates.push(content);
          } else {
            // No window open — load session, append version, open window
            const session = getSession(filePath);
            const existing = session?.versions ?? [];
            const version: SessionVersion = {
              id: crypto.randomUUID(),
              text: content,
              annotations: [],
              createdAt: Date.now(),
            };
            saveSession(filePath, [...existing, version]);
            windows.set(filePath, { filePath, contentUpdates: [] });
          }
        },
      },
      testDir
    );
    await wait(WATCHER_SETTLE_MS);
  }

  it("new file → opens window, edit → updates same window", async () => {
    await startSimulatedApp();

    // 1. Create a new markdown file
    const planPath = join(testDir, "my-plan.md");
    await writeFile(planPath, "# My Plan\n\nStep 1: do stuff");
    await waitFor(() => windows.size >= 1);

    expect(windows.has(planPath)).toBe(true);
    expect(windows.size).toBe(1);

    // Session was saved
    const session = getSession(planPath);
    expect(session).toBeDefined();
    expect(session!.versions).toHaveLength(1);
    expect(session!.versions[0].text).toBe("# My Plan\n\nStep 1: do stuff");

    // 2. Edit the file — should update the same window, not open a new one
    await writeFile(planPath, "# My Plan v2\n\nStep 1: revised");
    await waitFor(
      () => windows.get(planPath)!.contentUpdates.length >= 1
    );

    expect(windows.size).toBe(1);
    expect(windows.get(planPath)!.contentUpdates).toEqual([
      "# My Plan v2\n\nStep 1: revised",
    ]);
  });

  it("two new files → two separate windows", async () => {
    await startSimulatedApp();

    const fileA = join(testDir, "plan-a.md");
    const fileB = join(testDir, "plan-b.md");

    await writeFile(fileA, "Plan A content");
    await waitFor(() => windows.size >= 1);

    await writeFile(fileB, "Plan B content");
    await waitFor(() => windows.size >= 2);

    expect(windows.has(fileA)).toBe(true);
    expect(windows.has(fileB)).toBe(true);
    expect(windows.size).toBe(2);
  });

  it("sessions persist → simulated restart restores all windows", async () => {
    await startSimulatedApp();

    // Create two files
    const fileA = join(testDir, "alpha.md");
    const fileB = join(testDir, "beta.md");

    await writeFile(fileA, "Alpha v1");
    await waitFor(() => windows.size >= 1);

    await writeFile(fileB, "Beta v1");
    await waitFor(() => windows.size >= 2);

    // Flush sessions to disk
    await flushWrites();
    stopWatching();

    // -- Simulate app restart --
    windows.clear();

    // Re-read sessions file (simulates loadSessions on app start)
    _setSessionsPathForTest(join(sessionsDir, "sessions.json"));
    const restored = await loadSessions();

    // Restore windows from sessions (mirrors index.ts logic)
    for (const session of restored) {
      windows.set(session.filePath, {
        filePath: session.filePath,
        contentUpdates: [],
      });
    }

    expect(windows.size).toBe(2);
    expect(windows.has(fileA)).toBe(true);
    expect(windows.has(fileB)).toBe(true);

    // Verify version history was preserved
    const sessionA = getSession(fileA);
    expect(sessionA!.versions[0].text).toBe("Alpha v1");
  });

  it("file changed with no window open → opens new window with full history", async () => {
    await startSimulatedApp();

    const filePath = join(testDir, "reopen.md");
    await writeFile(filePath, "initial");
    await waitFor(() => windows.size >= 1);

    // Simulate user closing the window
    windows.delete(filePath);
    expect(windows.size).toBe(0);

    // File changes while no window is open
    await writeFile(filePath, "updated after close");
    await waitFor(() => windows.size >= 1);

    expect(windows.has(filePath)).toBe(true);

    // Session should have both versions
    const session = getSession(filePath);
    expect(session).toBeDefined();
    expect(session!.versions).toHaveLength(2);
    expect(session!.versions[0].text).toBe("initial");
    expect(session!.versions[1].text).toBe("updated after close");
  });

  it("sessions file is valid JSON on disk", async () => {
    await startSimulatedApp();

    await writeFile(join(testDir, "check.md"), "hello world");
    await waitFor(() => windows.size >= 1);

    await flushWrites();

    const raw = await readFile(join(sessionsDir, "sessions.json"), "utf-8");
    const parsed = JSON.parse(raw);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].filePath).toContain("check.md");
    expect(parsed[0].versions[0].text).toBe("hello world");
  });
});
