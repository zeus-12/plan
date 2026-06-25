import { contextBridge, ipcRenderer } from "electron";
import type { SessionEvent } from "../main/session-watcher";
import type { SearchOptions } from "../shared-types";
import type { ProjectDefaults, CreatePrInput } from "../shared-types";

const electronAPI = {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  listSessions: (encoded: string) =>
    ipcRenderer.invoke("projects:listSessions", encoded),
  readSession: (encoded: string, sessionId: string) =>
    ipcRenderer.invoke("session:read", encoded, sessionId),
  getDiff: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("project:diff", encoded, subPath),
  getFileContents: (
    encoded: string,
    oldPath: string | null,
    newPath: string | null,
    subPath: string = ""
  ) =>
    ipcRenderer.invoke(
      "project:fileContents",
      encoded,
      oldPath,
      newPath,
      subPath
    ),
  listRepos: (encoded: string) => ipcRenderer.invoke("repos:list", encoded),

  listWorktrees: (encoded: string) =>
    ipcRenderer.invoke("worktrees:list", encoded),
  createWorktree: (
    encoded: string,
    input: { name: string; branch: string; base: string }
  ) => ipcRenderer.invoke("worktrees:create", encoded, input),
  removeWorktree: (id: string) => ipcRenderer.invoke("worktrees:remove", id),
  createWorktreePr: (id: string, input: CreatePrInput) =>
    ipcRenderer.invoke("worktrees:createPr", id, input),
  getWorktreeDefaults: (encoded: string) =>
    ipcRenderer.invoke("worktrees:getDefaults", encoded),
  setWorktreeDefaults: (encoded: string, defaults: ProjectDefaults) =>
    ipcRenderer.invoke("worktrees:setDefaults", encoded, defaults),
  getFileView: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath: string = ""
  ) => ipcRenderer.invoke("project:fileView", encoded, path, mode, subPath),
  getFileImageDiff: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath: string = ""
  ) =>
    ipcRenderer.invoke("project:fileImageDiff", encoded, path, mode, subPath),

  listProjectFiles: (encoded: string) =>
    ipcRenderer.invoke("files:list", encoded),
  readProjectFile: (encoded: string, relPath: string) =>
    ipcRenderer.invoke("files:read", encoded, relPath),
  projectFilePath: (encoded: string, relPath: string) =>
    ipcRenderer.invoke("files:path", encoded, relPath),
  listSkills: (encoded: string) => ipcRenderer.invoke("skills:list", encoded),
  searchProjectFiles: (encoded: string, query: string, opts: SearchOptions) =>
    ipcRenderer.invoke("files:search", encoded, query, opts),

  onWatcherEvent: (cb: (e: SessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: SessionEvent) =>
      cb(e);
    ipcRenderer.on("watcher:event", handler);
    return () => ipcRenderer.removeListener("watcher:event", handler);
  },

  // Start/stop watching the active project's real worktree on disk (file edits,
  // git ops made outside the app). Scoped to the mounted workspace.
  watchWorktree: (encoded: string) =>
    ipcRenderer.invoke("worktree:watch", encoded),
  unwatchWorktree: (encoded: string) =>
    ipcRenderer.invoke("worktree:unwatch", encoded),

  // Ctrl+Tab (sessions) / Ctrl+` (projects) cycles, forwarded from main since
  // Chromium swallows Ctrl+Tab before the page sees it. `key` is the
  // KeyboardEvent.code of the trigger; `shift` reverses direction.
  onSwitcherCycle: (cb: (e: { key: string; shift: boolean }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      e: { key: string; shift: boolean },
    ) => cb(e);
    ipcRenderer.on("switcher:cycle", handler);
    return () => ipcRenderer.removeListener("switcher:cycle", handler);
  },

  addManualProject: () => ipcRenderer.invoke("projects:addManual"),
  setProjectArchived: (encoded: string, archived: boolean) =>
    ipcRenderer.invoke("projects:setArchived", encoded, archived),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    ipcRenderer.invoke("sessions:setArchived", sessionId, archived),
  renameSession: (sessionId: string, name: string) =>
    ipcRenderer.invoke("sessions:rename", sessionId, name),

  // Git
  getBranch: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:branch", encoded, subPath),
  getGitStatus: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:status", encoded, subPath),
  stageFile: (encoded: string, path: string, subPath: string = "") =>
    ipcRenderer.invoke("git:stage", encoded, path, subPath),
  unstageFile: (encoded: string, path: string, subPath: string = "") =>
    ipcRenderer.invoke("git:unstage", encoded, path, subPath),
  discardFile: (encoded: string, path: string, subPath: string = "") =>
    ipcRenderer.invoke("git:discard", encoded, path, subPath),
  stageAll: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:stageAll", encoded, subPath),
  unstageAll: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:unstageAll", encoded, subPath),
  discardAll: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:discardAll", encoded, subPath),
  stashAll: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:stashAll", encoded, subPath),
  push: (encoded: string, subPath: string = "") =>
    ipcRenderer.invoke("git:push", encoded, subPath),

  // Terminal (keyed by terminal id; cwd resolved from encoded in main)
  terminalOpen: (
    id: string,
    encoded: string,
    cols: number,
    rows: number,
    initialCommand?: string
  ) =>
    ipcRenderer.invoke(
      "terminal:open",
      id,
      encoded,
      cols,
      rows,
      initialCommand
    ),
  terminalInput: (id: string, data: string) =>
    ipcRenderer.send("terminal:input", id, data),
  terminalSubmit: (id: string, text: string, imagePaths: string[] = []) =>
    ipcRenderer.send("terminal:submit", id, text, imagePaths),
  terminalSendKeys: (id: string, keys: string[]) =>
    ipcRenderer.send("terminal:sendKeys", id, keys),
  terminalStatus: (id: string) => ipcRenderer.invoke("terminal:status", id),
  terminalInputState: (id: string) =>
    ipcRenderer.invoke("terminal:inputState", id),
  terminalDump: (id: string) => ipcRenderer.invoke("terminal:dump", id),
  terminalBusyIds: () => ipcRenderer.invoke("terminal:busyIds"),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.send("terminal:kill", id),
  terminalList: () => ipcRenderer.invoke("terminal:list"),
  saveTempImage: (data: Uint8Array, ext: string) =>
    ipcRenderer.invoke("terminal:saveTempImage", data, ext),
  fileExists: (path: string) =>
    ipcRenderer.invoke("terminal:fileExists", path),
  onTerminalData: (cb: (chunk: { id: string; data: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      chunk: { id: string; data: string }
    ) => cb(chunk);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  onTerminalExit: (cb: (id: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => cb(id);
    ipcRenderer.on("terminal:exit", handler);
    return () => ipcRenderer.removeListener("terminal:exit", handler);
  },
  commit: (encoded: string, message: string, subPath: string = "") =>
    ipcRenderer.invoke("git:commit", encoded, message, subPath),
  applyPatch: (
    encoded: string,
    patch: string,
    mode: "stage" | "unstage" | "discard" | "apply",
    subPath: string = ""
  ) => ipcRenderer.invoke("git:applyPatch", encoded, patch, mode, subPath),

  // Updates (notify-only — see main/updates.ts)
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  openUpdateDownload: (url: string) =>
    ipcRenderer.invoke("updates:openDownload", url),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
