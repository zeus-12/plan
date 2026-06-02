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

  onWatcherEvent: (cb: (e: SessionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: SessionEvent) =>
      cb(e);
    ipcRenderer.on("watcher:event", handler);
    return () => ipcRenderer.removeListener("watcher:event", handler);
  },

  addManualProject: () => ipcRenderer.invoke("projects:addManual"),
  setProjectArchived: (encoded: string, archived: boolean) =>
    ipcRenderer.invoke("projects:setArchived", encoded, archived),

  // Plans
  listPlans: () => ipcRenderer.invoke("plans:list"),
  markPlanRead: (filePath: string) =>
    ipcRenderer.invoke("plans:markRead", filePath),
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

  // Terminal
  terminalOpen: (encoded: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:open", encoded, cols, rows),
  terminalInput: (encoded: string, data: string) =>
    ipcRenderer.send("terminal:input", encoded, data),
  terminalResize: (encoded: string, cols: number, rows: number) =>
    ipcRenderer.send("terminal:resize", encoded, cols, rows),
  terminalKill: (encoded: string) =>
    ipcRenderer.send("terminal:kill", encoded),
  onTerminalData: (cb: (chunk: { encoded: string; data: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      chunk: { encoded: string; data: string }
    ) => cb(chunk);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  onTerminalExit: (cb: (encoded: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, encoded: string) =>
      cb(encoded);
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
