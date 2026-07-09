import { contextBridge, ipcRenderer } from "electron";
import {
  API_INVOKE,
  API_SEND,
  API_EVENTS,
  type ElectronAPI,
} from "../ipc-contract";

// The whole bridge is derived from the contract's name→channel maps: every
// method is a pure forward (defaults for optional args live in main's
// handlers). The single cast at the bottom is sound because the maps drive
// both this object's runtime shape and the ElectronAPI type.
const api: Record<string, unknown> = {};

for (const [method, channel] of Object.entries(API_INVOKE)) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

for (const [method, channel] of Object.entries(API_SEND)) {
  api[method] = (...args: unknown[]) => ipcRenderer.send(channel, ...args);
}

for (const [method, channel] of Object.entries(API_EVENTS)) {
  api[method] = (cb: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("electronAPI", api as ElectronAPI);
