import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  loadSessions,
  saveSession,
  getSession,
  type SessionVersion,
} from "./sessions";
import { startDirectoryWatcher, stopWatching } from "./watcher";

const isMac = process.platform === "darwin";
const windowMap = new Map<string, BrowserWindow>();

// ── Native macOS menu ──────────────────────────────────────────────

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
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Dock management ────────────────────────────────────────────────

function showDock() {
  if (isMac && app.dock) {
    app.dock.show();
  }
}

function hideDock() {
  if (isMac && app.dock) {
    app.dock.hide();
  }
}

function bounceDock() {
  if (isMac && app.dock) {
    app.dock.bounce("informational");
  }
}

// ── Window helpers ─────────────────────────────────────────────────

function bringToFront(win: BrowserWindow) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(filePath: string): BrowserWindow {
  showDock();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
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
    windowMap.delete(filePath);
    if (windowMap.size === 0) {
      hideDock();
    }
  });

  windowMap.set(filePath, win);
  return win;
}

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  hideDock();

  // Renderer pulls its init data
  ipcMain.handle("auto:init", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    for (const [filePath, w] of windowMap) {
      if (w === win) {
        const session = getSession(filePath);
        const versions = session?.versions ?? [];

        let pendingContent: string | null = null;
        try {
          const currentContent = await readFile(filePath, "utf-8");
          const lastVersion = versions[versions.length - 1];
          if (lastVersion && currentContent !== lastVersion.text) {
            pendingContent = currentContent;
          }
        } catch {
          // file might not exist anymore
        }

        return { file: filePath, versions, pendingContent };
      }
    }

    return null;
  });

  // Renderer saves its version state
  ipcMain.on(
    "session:save",
    (
      _event,
      { filePath, versions }: { filePath: string; versions: SessionVersion[] }
    ) => {
      saveSession(filePath, versions);
    }
  );

  // Restore saved sessions
  const sessions = await loadSessions();
  for (const session of sessions) {
    createWindow(session.filePath);
  }

  // Start directory watcher
  await startDirectoryWatcher({
    onNewFile(filePath, content) {
      const version: SessionVersion = {
        id: crypto.randomUUID(),
        text: content,
        annotations: [],
        createdAt: Date.now(),
      };
      saveSession(filePath, [version]);
      const win = createWindow(filePath);
      bringToFront(win);
      bounceDock();
    },
    onFileChanged(filePath, content) {
      const win = windowMap.get(filePath);
      if (win) {
        win.webContents.send("auto:content", content);
        bringToFront(win);
        bounceDock();
      } else {
        const session = getSession(filePath);
        const existingVersions = session?.versions ?? [];
        const version: SessionVersion = {
          id: crypto.randomUUID(),
          text: content,
          annotations: [],
          createdAt: Date.now(),
        };
        const allVersions = [...existingVersions, version];
        saveSession(filePath, allVersions);
        const newWin = createWindow(filePath);
        bringToFront(newWin);
        bounceDock();
      }
    },
  });

  app.on("activate", () => {
    // macOS dock click — no-op, windows appear when files change
  });
});

app.on("window-all-closed", () => {
  if (!isMac) {
    stopWatching();
    app.quit();
  }
});
