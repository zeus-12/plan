import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, shell } from "electron";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { stat, writeFile } from "fs/promises";
import {
  listProjects,
  resolveProjectCwd,
  CLAUDE_PROJECTS_DIR,
} from "./claude-projects";
import {
  getManualCwds,
  addManualCwd,
  encodeCwd,
  getArchivedEncoded,
  setArchived,
  getArchivedSessions,
  setSessionArchived,
  getSessionNames,
  setSessionName,
} from "./manual-projects";
import type { ProjectEntry } from "../shared-types";
import {
  setCallbacks,
  startWatching,
  startRootWatch,
  stopAll,
} from "./session-watcher";
import { readSessionFile, type ParsedSession } from "./jsonl-parser";
import { getWorkingTreeDiff } from "./git-diff";
import { getFileContents, getFileView } from "./file-contents";
import {
  listProjectFiles,
  readProjectFile,
  resolveProjectFilePath,
} from "./project-files";
import { readdir } from "fs/promises";
import { startPlansWatcher, stopPlansWatcher } from "./plans-watcher";
import {
  flushWrites as flushPlansWrites,
  getPlans,
  loadPlans,
  markPlanRead,
  recordNewPlan,
  recordPlanChange,
  removePlan,
  setPlanArchived,
} from "./plans-store";
import {
  setTerminalCallbacks,
  openTerminal,
  writeTerminal,
  submitToTerminal,
  sendKeys,
  terminalStatus,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  listTerminals,
  type TerminalChunk,
} from "./terminal";
import {
  applyPatch,
  commit as gitCommit,
  discardAll,
  discardFile,
  discoverRepos,
  getBranch,
  getStatus,
  push as gitPush,
  stageAll,
  stageFile,
  stashAll,
  unstageAll,
  unstageFile,
} from "./git";

const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;

// ── Menu ───────────────────────────────────────────────────────────

function sendSwitcherCycle(shift: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("switcher:cycle", { shift });
}

// Ctrl+Tab / Ctrl+Shift+Tab via OS-level hotkeys. This is the dependable way
// to catch Ctrl+Tab on macOS — Chromium swallows it before the page's keydown,
// and a menu accelerator for Tab is unreliable. globalShortcut taps the event
// at the OS level, so it always fires. We register only while OUR window is
// focused (toggled on focus/blur) so the combo isn't hijacked from other apps.
// Commit-on-release still works: globalShortcut consumes Ctrl+Tab but not a
// lone Ctrl keyup, so the renderer still sees the release.
let switcherRegistered = false;

function registerSwitcherShortcuts() {
  if (switcherRegistered) return;
  const a = globalShortcut.register("Control+Tab", () => sendSwitcherCycle(false));
  const b = globalShortcut.register("Control+Shift+Tab", () =>
    sendSwitcherCycle(true)
  );
  switcherRegistered = a || b;
  console.log("[switcher] globalShortcut registered:", { ctrlTab: a, ctrlShiftTab: b });
}

function unregisterSwitcherShortcuts() {
  if (!switcherRegistered) return;
  globalShortcut.unregister("Control+Tab");
  globalShortcut.unregister("Control+Shift+Tab");
  switcherRegistered = false;
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Window ─────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#fafafa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Transcript images are shown via <img src="file://…"> from their local
      // path. In dev the renderer is served over http, whose origin blocks
      // file:// subresources — so relax webSecurity in dev only. Production
      // loads the renderer from file:// and is unaffected (stays secure).
      webSecurity: app.isPackaged,
    },
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Scope the Ctrl+Tab hotkeys to when this window actually has focus.
  win.on("focus", registerSwitcherShortcuts);
  win.on("blur", unregisterSwitcherShortcuts);

  // Markdown links (target=_blank) open in the user's real browser, not a
  // blank Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Ctrl+Tab / Ctrl+Shift+Tab switcher. Chromium swallows plain Ctrl+Tab
  // before the page's keydown sees it, and a macOS menu accelerator for Tab is
  // unreliable (often consumed by AppKit without firing). before-input-event is
  // the dependable interception point: it fires before the page, so we cancel
  // the keystroke and forward a cycle to the renderer, which owns the modal and
  // commits when the user releases Ctrl.
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.key === "Tab" &&
      input.control &&
      !input.meta &&
      !input.alt
    ) {
      event.preventDefault();
      sendSwitcherCycle(input.shift);
    }
  });

  mainWindow = win;
  return win;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Session listing ────────────────────────────────────────────────

interface SessionListEntry {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  archived: boolean;
  title: string | null;
  messageCount: number;
  updatedAt: number | string | null;
}

/**
 * Display metadata per session file, cached by mtime. The renderer must NEVER
 * fetch full transcripts just to label the list — that shipped megabytes over
 * IPC on every watcher tick and froze the renderer. Only files whose mtime
 * changed (i.e. the actively-streaming session) are re-parsed, in main.
 */
const sessionMetaCache = new Map<
  string,
  {
    mtimeMs: number;
    title: string | null;
    messageCount: number;
    updatedAt: number | string | null;
  }
>();

async function sessionMeta(filePath: string, mtimeMs: number) {
  const cached = sessionMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let meta;
  try {
    const parsed = await readSessionFile(filePath);
    meta = {
      mtimeMs,
      title: parsed.meta.title ?? null,
      messageCount: parsed.meta.messageCount ?? 0,
      updatedAt: parsed.meta.updatedAt ?? mtimeMs,
    };
  } catch {
    meta = { mtimeMs, title: null, messageCount: 0, updatedAt: mtimeMs };
  }
  sessionMetaCache.set(filePath, meta);
  return meta;
}

async function listSessionsForProject(encoded: string): Promise<SessionListEntry[]> {
  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const [archivedIds, names] = await Promise.all([
      getArchivedSessions(),
      getSessionNames(),
    ]);
    const archived = new Set(archivedIds);
    const out: SessionListEntry[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const filePath = join(dir, e.name);
      try {
        const s = await stat(filePath);
        const sessionId = e.name.replace(/\.jsonl$/, "");
        const meta = await sessionMeta(filePath, s.mtimeMs);
        out.push({
          sessionId,
          filePath,
          mtimeMs: s.mtimeMs,
          archived: archived.has(sessionId),
          // A user-assigned name wins over the derived title.
          title: names[sessionId] ?? meta.title,
          messageCount: meta.messageCount,
          updatedAt: meta.updatedAt,
        });
      } catch {
        // skip
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch {
    return [];
  }
}

// ── IPC ─────────────────────────────────────────────────────────────

/** Most recent session-file mtime for a project (for activity sorting). */
async function latestActivity(encoded: string): Promise<number> {
  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let max = 0;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      try {
        const s = await stat(join(dir, e.name));
        if (s.mtimeMs > max) max = s.mtimeMs;
      } catch {
        // skip
      }
    }
    return max;
  } catch {
    return 0;
  }
}

// Only manually-added projects are shown (persisted in plan-desktop.json), so
// the sidebar starts empty and the user curates it via "Add project". Sessions
// for each still come from ~/.claude/projects/<encoded>. `mtimeMs` is the
// latest session activity so the sidebar can sort most-recent-first.
async function listAllProjects(): Promise<ProjectEntry[]> {
  const [manualCwds, archivedEncoded] = await Promise.all([
    getManualCwds(),
    getArchivedEncoded(),
  ]);
  const archived = new Set(archivedEncoded);
  return Promise.all(
    manualCwds.map(async (cwd) => {
      const encoded = encodeCwd(cwd);
      return {
        encoded,
        cwd,
        mtimeMs: await latestActivity(encoded),
        archived: archived.has(encoded),
      };
    })
  );
}

function registerIpc() {
  ipcMain.handle("projects:list", async () => listAllProjects());

  ipcMain.handle("projects:addManual", async (event): Promise<ProjectEntry | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const res = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: "Add project",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const cwd = res.filePaths[0];
    await addManualCwd(cwd);
    return { encoded: encodeCwd(cwd), cwd, mtimeMs: 0, archived: false };
  });

  ipcMain.handle(
    "projects:setArchived",
    async (_event, encoded: string, archived: boolean) => {
      await setArchived(encoded, archived);
      return { ok: true };
    }
  );

  ipcMain.handle("projects:listSessions", async (_e, encoded: string) =>
    listSessionsForProject(encoded)
  );

  ipcMain.handle(
    "sessions:setArchived",
    async (_e, sessionId: string, archived: boolean) => {
      await setSessionArchived(sessionId, archived);
      return { ok: true };
    }
  );

  ipcMain.handle(
    "sessions:rename",
    async (_e, sessionId: string, name: string) => {
      await setSessionName(sessionId, name);
      return { ok: true };
    }
  );

  ipcMain.handle(
    "session:read",
    async (_e, encoded: string, sessionId: string): Promise<ParsedSession | null> => {
      const filePath = join(CLAUDE_PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
      try {
        return await readSessionFile(filePath);
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle(
    "project:diff",
    async (_e, encoded: string, subPath: string = "") => {
      const base = await resolveProjectCwd(encoded);
      const cwd = subPath ? join(base, subPath) : base;
      return getWorkingTreeDiff(cwd);
    }
  );

  ipcMain.handle(
    "project:fileContents",
    async (
      _e,
      encoded: string,
      oldPath: string | null,
      newPath: string | null,
      subPath: string = ""
    ) => getFileContents(encoded, oldPath, newPath, subPath)
  );
  ipcMain.handle(
    "project:fileView",
    async (
      _e,
      encoded: string,
      path: string,
      mode: "staged" | "unstaged",
      subPath: string = ""
    ) => getFileView(encoded, path, mode, subPath)
  );

  ipcMain.handle("files:list", async (_e, encoded: string) =>
    listProjectFiles(encoded)
  );
  ipcMain.handle("files:read", async (_e, encoded: string, relPath: string) =>
    readProjectFile(encoded, relPath)
  );
  ipcMain.handle("files:path", async (_e, encoded: string, relPath: string) =>
    resolveProjectFilePath(encoded, relPath)
  );

  ipcMain.handle("repos:list", async (_e, encoded: string) =>
    discoverRepos(encoded)
  );

  ipcMain.handle("plans:list", async () => getPlans());
  ipcMain.handle("plans:markRead", async (_e, filePath: string) => {
    markPlanRead(filePath);
    return { ok: true };
  });
  ipcMain.handle(
    "plans:setArchived",
    async (_e, filePath: string, archived: boolean) => {
      setPlanArchived(filePath, archived);
      return { ok: true };
    }
  );

  // Git
  ipcMain.handle("git:branch", async (_e, encoded: string, subPath: string = "") =>
    getBranch(encoded, subPath)
  );
  ipcMain.handle("git:status", async (_e, encoded: string, subPath: string = "") =>
    getStatus(encoded, subPath)
  );
  ipcMain.handle(
    "git:stage",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      stageFile(encoded, path, subPath)
  );
  ipcMain.handle(
    "git:unstage",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      unstageFile(encoded, path, subPath)
  );
  ipcMain.handle(
    "git:discard",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      discardFile(encoded, path, subPath)
  );
  ipcMain.handle("git:stageAll", async (_e, encoded: string, subPath: string = "") =>
    stageAll(encoded, subPath)
  );
  ipcMain.handle(
    "git:unstageAll",
    async (_e, encoded: string, subPath: string = "") =>
      unstageAll(encoded, subPath)
  );
  ipcMain.handle(
    "git:discardAll",
    async (_e, encoded: string, subPath: string = "") =>
      discardAll(encoded, subPath)
  );
  ipcMain.handle(
    "git:stashAll",
    async (_e, encoded: string, subPath: string = "") =>
      stashAll(encoded, subPath)
  );
  ipcMain.handle("git:push", async (_e, encoded: string, subPath: string = "") =>
    gitPush(encoded, subPath)
  );
  ipcMain.handle(
    "git:commit",
    async (_e, encoded: string, message: string, subPath: string = "") =>
      gitCommit(encoded, message, subPath)
  );
  ipcMain.handle(
    "git:applyPatch",
    async (
      _e,
      encoded: string,
      patch: string,
      mode: "stage" | "unstage" | "discard" | "apply",
      subPath: string = ""
    ) => applyPatch(encoded, patch, { mode }, subPath)
  );

  // Terminal ptys (keyed by terminal id; cwd resolved from encoded)
  ipcMain.handle(
    "terminal:open",
    async (
      _e,
      id: string,
      encoded: string,
      cols: number,
      rows: number,
      initialCommand?: string
    ) => openTerminal(id, encoded, cols, rows, initialCommand)
  );
  ipcMain.on("terminal:input", (_e, id: string, data: string) =>
    writeTerminal(id, data)
  );
  ipcMain.on("terminal:submit", (_e, id: string, text: string) =>
    submitToTerminal(id, text)
  );
  ipcMain.on("terminal:sendKeys", (_e, id: string, keys: string[]) =>
    sendKeys(id, keys)
  );
  ipcMain.handle("terminal:status", (_e, id: string) => terminalStatus(id));
  ipcMain.on(
    "terminal:resize",
    (_e, id: string, cols: number, rows: number) =>
      resizeTerminal(id, cols, rows)
  );
  ipcMain.on("terminal:kill", (_e, id: string) => killTerminal(id));
  ipcMain.handle("terminal:list", () => listTerminals());

  // Write a pasted image to a temp file; the renderer types the path into the
  // terminal (Claude Code reads image paths as attachments).
  ipcMain.handle(
    "terminal:saveTempImage",
    async (_e, data: Uint8Array, ext: string) => {
      try {
        const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : "png";
        const file = join(
          tmpdir(),
          `plan-paste-${randomUUID()}.${safeExt}`
        );
        await writeFile(file, Buffer.from(data));
        return file;
      } catch {
        return null;
      }
    }
  );
}

// ── Watcher → renderer bridge ──────────────────────────────────────

function bridgeWatcher() {
  setCallbacks({
    onEvent(e) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("watcher:event", e);
    },
  });
}

function bridgeTerminal() {
  setTerminalCallbacks({
    onData(chunk: TerminalChunk) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("terminal:data", chunk);
    },
    onExit(id: string) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("terminal:exit", id);
    },
  });
}

async function bridgePlansWatcher() {
  await loadPlans();
  await startPlansWatcher({
    onNewFile(filePath, content) {
      recordNewPlan(filePath, content);
      sendPlansEvent({ kind: "new-plan", filePath });
    },
    onFileChanged(filePath, content) {
      recordPlanChange(filePath, content);
      sendPlansEvent({ kind: "plan-changed", filePath });
    },
    onFileRemoved(filePath) {
      removePlan(filePath);
      sendPlansEvent({ kind: "plan-removed", filePath });
    },
  });
}

function sendPlansEvent(e: { kind: string; filePath: string }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("plans:event", e);
}

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  registerIpc();
  bridgeWatcher();
  bridgeTerminal();

  createMainWindow();
  // Register immediately too — the window opens focused, but don't rely solely
  // on the focus event's timing.
  registerSwitcherShortcuts();

  // Auto-watch every existing project, plus the root for new ones.
  const projects = await listProjects();
  for (const p of projects) {
    void startWatching(p.encoded);
  }
  void startRootWatch();
  void bridgePlansWatcher();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else focusMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) {
    stopAll();
    app.quit();
  }
});

app.on("before-quit", async () => {
  stopAll();
  killAllTerminals();
  await stopPlansWatcher();
  await flushPlansWrites();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
