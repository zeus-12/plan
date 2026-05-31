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
  commit: (encoded: string, message: string, subPath: string = "") =>
    ipcRenderer.invoke("git:commit", encoded, message, subPath),
  applyPatch: (
    encoded: string,
    patch: string,
    mode: "stage" | "unstage" | "discard",
    subPath: string = ""
  ) => ipcRenderer.invoke("git:applyPatch", encoded, patch, mode, subPath),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
