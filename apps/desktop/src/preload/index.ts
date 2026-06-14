import { contextBridge, ipcRenderer } from "electron";
import type { SessionEvent } from "../main/session-watcher";
import type { PlansEvent } from "../shared-types";

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
  getFileView: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath: string = ""
  ) => ipcRenderer.invoke("project:fileView", encoded, path, mode, subPath),

  listProjectFiles: (encoded: string) =>
    ipcRenderer.invoke("files:list", encoded),
  readProjectFile: (encoded: string, relPath: string) =>
    ipcRenderer.invoke("files:read", encoded, relPath),
  projectFilePath: (encoded: string, relPath: string) =>
    ipcRenderer.invoke("files:path", encoded, relPath),

  onWatcherEvent: (cb: (e: SessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: SessionEvent) =>
      cb(e);
    ipcRenderer.on("watcher:event", handler);
    return () => ipcRenderer.removeListener("watcher:event", handler);
  },

  // Ctrl+Tab (projects) / Ctrl+Shift+Tab (sessions), forwarded from main since
  // Chromium swallows Ctrl+Tab before the page sees it.
  onSwitcherCycle: (cb: (e: { shift: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: { shift: boolean }) =>
      cb(e);
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

  // Plans
  listPlans: () => ipcRenderer.invoke("plans:list"),
  markPlanRead: (filePath: string) =>
    ipcRenderer.invoke("plans:markRead", filePath),
  setPlanArchived: (filePath: string, archived: boolean) =>
    ipcRenderer.invoke("plans:setArchived", filePath, archived),
  onPlansEvent: (cb: (e: PlansEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: PlansEvent) =>
      cb(e);
    ipcRenderer.on("plans:event", handler);
    return () => ipcRenderer.removeListener("plans:event", handler);
  },

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
  terminalSubmit: (id: string, text: string) =>
    ipcRenderer.send("terminal:submit", id, text),
  terminalSendKeys: (id: string, keys: string[]) =>
    ipcRenderer.send("terminal:sendKeys", id, keys),
  terminalStatus: (id: string) => ipcRenderer.invoke("terminal:status", id),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.send("terminal:kill", id),
  terminalList: () => ipcRenderer.invoke("terminal:list"),
  saveTempImage: (data: Uint8Array, ext: string) =>
    ipcRenderer.invoke("terminal:saveTempImage", data, ext),
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
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
