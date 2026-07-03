import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { stat, writeFile } from "fs/promises";
import {
  listProjects,
  resolveProjectCwd,
  primeProjectCwd,
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
import { readClaudeConfig, writeClaudeConfig } from "./claude-config";
import type { ProjectEntry } from "../shared-types";
import {
  setCallbacks,
  startWatching,
  startRootWatch,
  stopAll,
} from "./session-watcher";
import {
  setWorktreeCallbacks,
  startWorktreeWatch,
  stopWorktreeWatch,
  stopAllWorktreeWatches,
} from "./worktree-watcher";
import {
  readSessionFile,
  readSessionMeta,
  type ParsedSession,
} from "./jsonl-parser";
import { getWorkingTreeDiff } from "./git-diff";
import { getFileContents, getFileView } from "./file-contents";
import { getFileImageDiff } from "./file-media";
import {
  listProjectFiles,
  readProjectFile,
  resolveProjectFilePath,
  searchProjectFiles,
} from "./project-files";
import { listSkills } from "./skills";
import { checkForUpdate } from "./updates";
import type { SearchOptions } from "../shared-types";
import { readdir } from "fs/promises";
import {
  setTerminalCallbacks,
  openTerminal,
  writeTerminal,
  submitToTerminal,
  sendKeys,
  terminalStatus,
  detectInputState,
  dumpTerminal,
  busyTerminalIds,
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
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  createWorktreePr,
  addReposToWorktree,
  type CreateWorktreeInput,
} from "./worktrees";
import type { CreatePrInput, AddReposToWorktreeInput } from "../shared-types";
import {
  getProjectDefaults,
  setProjectDefaults,
  type ProjectDefaults,
} from "./worktrees-store";

const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;

// ── Menu ───────────────────────────────────────────────────────────

function sendSwitcherCycle(key: string, shift: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("switcher:cycle", { key, shift });
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
  const a = globalShortcut.register("Control+Tab", () =>
    sendSwitcherCycle("Tab", false),
  );
  const b = globalShortcut.register("Control+Shift+Tab", () =>
    sendSwitcherCycle("Tab", true),
  );
  // Projects (Ctrl+`) get the SAME OS-level hook as Tab. before-input-event
  // alone proved unreliable — when a terminal/xterm pane holds focus the page
  // keydown is swallowed and the project switcher silently dies, while Tab kept
  // working precisely because globalShortcut bypasses page-level handling. The
  // backtick lives on the same physical key as ~, so Shift uses that accelerator.
  const c = globalShortcut.register("Control+`", () =>
    sendSwitcherCycle("Backquote", false),
  );
  const d = globalShortcut.register("Control+~", () =>
    sendSwitcherCycle("Backquote", true),
  );
  // Worktrees (Ctrl+1). Chromium reserves Ctrl+1‑9 for tab navigation and
  // swallows them before the page's keydown, so — like Tab/backtick — we tap it
  // at the OS level and forward. Ctrl+Shift+1 reverses.
  const e = globalShortcut.register("Control+1", () =>
    sendSwitcherCycle("Digit1", false),
  );
  const f = globalShortcut.register("Control+Shift+1", () =>
    sendSwitcherCycle("Digit1", true),
  );
  switcherRegistered = a || b || c || d || e || f;
  console.log("[switcher] globalShortcut registered:", {
    ctrlTab: a,
    ctrlShiftTab: b,
    ctrlBacktick: c,
    ctrlTilde: d,
    ctrl1: e,
    ctrlShift1: f,
  });
}

function unregisterSwitcherShortcuts() {
  if (!switcherRegistered) return;
  globalShortcut.unregister("Control+Tab");
  globalShortcut.unregister("Control+Shift+Tab");
  globalShortcut.unregister("Control+`");
  globalShortcut.unregister("Control+~");
  globalShortcut.unregister("Control+1");
  globalShortcut.unregister("Control+Shift+1");
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

  // Ctrl+Tab (sessions) / Ctrl+` (projects) switcher; Shift reverses direction.
  // Chromium swallows plain Ctrl+Tab before the page's keydown sees it, and a
  // macOS menu accelerator for Tab is unreliable (often consumed by AppKit
  // without firing). before-input-event is the dependable interception point:
  // it fires before the page, so we cancel the keystroke and forward a cycle to
  // the renderer, which owns the modal and commits when the user releases Ctrl.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    // Ctrl+Tab cycles sessions — Tab stays Ctrl-only because Cmd+Tab is the
    // macOS app switcher and must not be hijacked. Projects cycle on Ctrl+` OR
    // Cmd+`: we accept Cmd because that's the key macOS users reach for, and
    // overriding the OS "cycle windows" shortcut is harmless in a single-window
    // app.
    const isTab = input.code === "Tab" && input.control && !input.meta;
    const isBackquote =
      input.code === "Backquote" && (input.control || input.meta);
    if (isTab || isBackquote) {
      event.preventDefault();
      sendSwitcherCycle(input.code, input.shift);
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
  derivedTitle: string | null;
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
    // Incremental: parses only the bytes appended since the last call, so the
    // actively-streaming session's growing file isn't fully re-parsed on every
    // watcher tick — just the few new lines.
    const lite = await readSessionMeta(filePath);
    meta = {
      mtimeMs,
      title: lite.title ?? null,
      messageCount: lite.messageCount ?? 0,
      updatedAt: lite.updatedAt ?? mtimeMs,
    };
  } catch {
    meta = cached
      ? { ...cached, mtimeMs }
      : { mtimeMs, title: null, messageCount: 0, updatedAt: mtimeMs };
  }
  sessionMetaCache.set(filePath, meta);
  return meta;
}

async function listSessionsForProject(
  encoded: string,
): Promise<SessionListEntry[]> {
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
          derivedTitle: meta.title,
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
      // A manually-added project's cwd is the exact folder the user picked —
      // it's authoritative. Seed the cache with it so resolveProjectCwd hands
      // back this root rather than re-deriving a path from the newest session
      // JSONL (which can land on an inner subfolder when the project root has
      // no session of its own, or when the lossy encoding shares a bucket).
      primeProjectCwd(encoded, cwd);
      return {
        encoded,
        cwd,
        mtimeMs: await latestActivity(encoded),
        archived: archived.has(encoded),
      };
    }),
  );
}

function registerIpc() {
  ipcMain.handle("projects:list", async () => listAllProjects());

  // Update notifier: report whether a newer release exists, and open the
  // download page in the user's browser. We never install — the app is unsigned.
  ipcMain.handle("updates:check", () => checkForUpdate());
  ipcMain.handle("updates:openDownload", (_e, url: string) => {
    if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle(
    "projects:addManual",
    async (event): Promise<ProjectEntry | null> => {
      const win =
        BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
      const res = await dialog.showOpenDialog(
        win ?? new BrowserWindow({ show: false }),
        {
          title: "Add project",
          properties: ["openDirectory", "createDirectory"],
        },
      );
      if (res.canceled || res.filePaths.length === 0) return null;
      const cwd = res.filePaths[0];
      await addManualCwd(cwd);
      return { encoded: encodeCwd(cwd), cwd, mtimeMs: 0, archived: false };
    },
  );

  ipcMain.handle(
    "projects:setArchived",
    async (_event, encoded: string, archived: boolean) => {
      await setArchived(encoded, archived);
      return { ok: true };
    },
  );

  ipcMain.handle("projects:listSessions", async (_e, encoded: string) =>
    listSessionsForProject(encoded),
  );

  ipcMain.handle(
    "sessions:setArchived",
    async (_e, sessionId: string, archived: boolean) => {
      await setSessionArchived(sessionId, archived);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "sessions:rename",
    async (_e, sessionId: string, name: string) => {
      await setSessionName(sessionId, name);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "session:read",
    async (
      _e,
      encoded: string,
      sessionId: string,
    ): Promise<ParsedSession | null> => {
      const filePath = join(CLAUDE_PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
      try {
        return await readSessionFile(filePath);
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    "project:diff",
    async (_e, encoded: string, subPath: string = "") => {
      const base = await resolveProjectCwd(encoded);
      const cwd = subPath ? join(base, subPath) : base;
      return getWorkingTreeDiff(cwd);
    },
  );

  ipcMain.handle(
    "project:fileContents",
    async (
      _e,
      encoded: string,
      oldPath: string | null,
      newPath: string | null,
      subPath: string = "",
    ) => getFileContents(encoded, oldPath, newPath, subPath),
  );
  ipcMain.handle(
    "project:fileView",
    async (
      _e,
      encoded: string,
      path: string,
      mode: "staged" | "unstaged",
      subPath: string = "",
    ) => getFileView(encoded, path, mode, subPath),
  );
  ipcMain.handle(
    "project:fileImageDiff",
    async (
      _e,
      encoded: string,
      path: string,
      mode: "staged" | "unstaged",
      subPath: string = "",
    ) => getFileImageDiff(encoded, path, mode, subPath),
  );

  ipcMain.handle("files:list", async (_e, encoded: string) =>
    listProjectFiles(encoded),
  );
  ipcMain.handle("files:read", async (_e, encoded: string, relPath: string) =>
    readProjectFile(encoded, relPath),
  );
  ipcMain.handle("files:path", async (_e, encoded: string, relPath: string) =>
    resolveProjectFilePath(encoded, relPath),
  );
  ipcMain.handle("skills:list", async (_e, encoded: string) =>
    listSkills(encoded),
  );
  ipcMain.handle("claudeConfig:read", async (_e, encoded: string | null) =>
    readClaudeConfig(encoded),
  );
  ipcMain.handle("claudeConfig:write", async (_e, path: string, text: string) =>
    writeClaudeConfig(path, text),
  );
  ipcMain.handle(
    "files:search",
    async (_e, encoded: string, query: string, opts: SearchOptions) => {
      // Never let an unexpected throw reject the IPC (which surfaces as an
      // opaque "Search failed" in the UI) — return it as a structured error.
      try {
        return await searchProjectFiles(encoded, query, opts);
      } catch (err) {
        return {
          files: [],
          totalMatches: 0,
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("repos:list", async (_e, encoded: string) =>
    discoverRepos(encoded),
  );

  // Worktrees
  ipcMain.handle("worktrees:list", async (_e, encoded: string) =>
    listWorktrees(encoded),
  );
  ipcMain.handle(
    "worktrees:create",
    async (_e, encoded: string, input: CreateWorktreeInput) =>
      createWorktree(encoded, input),
  );
  ipcMain.handle("worktrees:remove", async (_e, id: string) =>
    removeWorktree(id),
  );
  ipcMain.handle(
    "worktrees:addRepos",
    async (_e, id: string, input: AddReposToWorktreeInput) =>
      addReposToWorktree(id, input),
  );
  ipcMain.handle(
    "worktrees:createPr",
    async (_e, id: string, input: CreatePrInput) => createWorktreePr(id, input),
  );
  ipcMain.handle("worktrees:getDefaults", async (_e, encoded: string) =>
    getProjectDefaults(encoded),
  );
  ipcMain.handle(
    "worktrees:setDefaults",
    async (_e, encoded: string, defaults: ProjectDefaults) =>
      setProjectDefaults(encoded, defaults),
  );

  // Git
  ipcMain.handle(
    "git:branch",
    async (_e, encoded: string, subPath: string = "") =>
      getBranch(encoded, subPath),
  );
  ipcMain.handle(
    "git:status",
    async (_e, encoded: string, subPath: string = "") =>
      getStatus(encoded, subPath),
  );
  ipcMain.handle(
    "git:stage",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      stageFile(encoded, path, subPath),
  );
  ipcMain.handle(
    "git:unstage",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      unstageFile(encoded, path, subPath),
  );
  ipcMain.handle(
    "git:discard",
    async (_e, encoded: string, path: string, subPath: string = "") =>
      discardFile(encoded, path, subPath),
  );
  ipcMain.handle(
    "git:stageAll",
    async (_e, encoded: string, subPath: string = "") =>
      stageAll(encoded, subPath),
  );
  ipcMain.handle(
    "git:unstageAll",
    async (_e, encoded: string, subPath: string = "") =>
      unstageAll(encoded, subPath),
  );
  ipcMain.handle(
    "git:discardAll",
    async (_e, encoded: string, subPath: string = "") =>
      discardAll(encoded, subPath),
  );
  ipcMain.handle(
    "git:stashAll",
    async (_e, encoded: string, subPath: string = "") =>
      stashAll(encoded, subPath),
  );
  ipcMain.handle(
    "git:push",
    async (_e, encoded: string, subPath: string = "") =>
      gitPush(encoded, subPath),
  );
  ipcMain.handle(
    "git:commit",
    async (_e, encoded: string, message: string, subPath: string = "") =>
      gitCommit(encoded, message, subPath),
  );
  ipcMain.handle(
    "git:applyPatch",
    async (
      _e,
      encoded: string,
      patch: string,
      mode: "stage" | "unstage" | "discard" | "apply",
      subPath: string = "",
    ) => applyPatch(encoded, patch, { mode }, subPath),
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
      initialCommand?: string,
      subPath = "",
    ) => openTerminal(id, encoded, cols, rows, initialCommand, subPath),
  );
  ipcMain.on("terminal:input", (_e, id: string, data: string) =>
    writeTerminal(id, data),
  );
  ipcMain.on(
    "terminal:submit",
    (_e, id: string, text: string, imagePaths: string[] = []) =>
      submitToTerminal(id, text, imagePaths),
  );
  ipcMain.on("terminal:sendKeys", (_e, id: string, keys: string[]) =>
    sendKeys(id, keys),
  );
  ipcMain.handle("terminal:status", (_e, id: string) => terminalStatus(id));
  ipcMain.handle("terminal:inputState", (_e, id: string) =>
    detectInputState(id),
  );
  ipcMain.handle("terminal:dump", (_e, id: string) => dumpTerminal(id));
  ipcMain.handle("terminal:busyIds", () => busyTerminalIds());
  ipcMain.on("terminal:resize", (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows),
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
        const file = join(tmpdir(), `plan-paste-${randomUUID()}.${safeExt}`);
        await writeFile(file, Buffer.from(data));
        return file;
      } catch {
        return null;
      }
    },
  );

  // Does a path still exist on disk? Used to verify a restored draft's pasted
  // images are still present before showing/sending them (the OS can purge tmp).
  ipcMain.handle("terminal:fileExists", async (_e, path: string) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  });

  // Worktree watching is scoped to whatever project workspace is mounted —
  // real repos are heavier to watch than the session JSONL dirs, so we only
  // watch the active one. The renderer calls these on mount/unmount.
  ipcMain.handle("worktree:watch", (_e, encoded: string) => {
    void startWorktreeWatch(encoded);
  });
  ipcMain.handle("worktree:unwatch", (_e, encoded: string) => {
    stopWorktreeWatch(encoded);
  });
}

// ── Watcher → renderer bridge ──────────────────────────────────────

function bridgeWatcher() {
  const send = (e: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("watcher:event", e);
  };
  setCallbacks({ onEvent: send });
  setWorktreeCallbacks({ onEvent: send });
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

  // Seed the cwd cache from the authoritative manual-project paths before any
  // terminal:open / files:list IPC can arrive, so those never resolve a project
  // root from session history.
  await listAllProjects().catch(() => {});

  // Auto-watch every existing project, plus the root for new ones.
  const projects = await listProjects();
  for (const p of projects) {
    void startWatching(p.encoded);
  }
  void startRootWatch();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else focusMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) {
    stopAll();
    stopAllWorktreeWatches();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAll();
  stopAllWorktreeWatches();
  killAllTerminals();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
