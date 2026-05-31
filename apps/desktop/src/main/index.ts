import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";
import { join } from "path";
import { stat } from "fs/promises";
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
import { getFileContents } from "./file-contents";
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
} from "./plans-store";
import {
  applyPatch,
  commit as gitCommit,
  discardFile,
  discoverRepos,
  getBranch,
  getStatus,
  stageAll,
  stageFile,
  unstageAll,
  unstageFile,
} from "./git";

const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;

// ── Menu ───────────────────────────────────────────────────────────

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
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#fafafa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
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
}

async function listSessionsForProject(encoded: string): Promise<SessionListEntry[]> {
  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: SessionListEntry[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const filePath = join(dir, e.name);
      try {
        const s = await stat(filePath);
        out.push({
          sessionId: e.name.replace(/\.jsonl$/, ""),
          filePath,
          mtimeMs: s.mtimeMs,
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

async function listAllProjects(): Promise<ProjectEntry[]> {
  const [auto, manualCwds, archivedEncoded] = await Promise.all([
    listProjects(),
    getManualCwds(),
    getArchivedEncoded(),
  ]);
  const archived = new Set(archivedEncoded);
  const seen = new Set(auto.map((p) => p.encoded));
  const out: ProjectEntry[] = auto.map((p) => ({
    ...p,
    archived: archived.has(p.encoded),
  }));
  for (const cwd of manualCwds) {
    const enc = encodeCwd(cwd);
    if (seen.has(enc)) continue;
    out.push({ encoded: enc, cwd, mtimeMs: 0, archived: archived.has(enc) });
  }
  return out;
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

  ipcMain.handle("repos:list", async (_e, encoded: string) =>
    discoverRepos(encoded)
  );

  ipcMain.handle("plans:list", async () => getPlans());
  ipcMain.handle("plans:markRead", async (_e, filePath: string) => {
    markPlanRead(filePath);
    return { ok: true };
  });

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
      mode: "stage" | "unstage" | "discard",
      subPath: string = ""
    ) => applyPatch(encoded, patch, { mode }, subPath)
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

  createMainWindow();

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
  await stopPlansWatcher();
  await flushPlansWrites();
});
