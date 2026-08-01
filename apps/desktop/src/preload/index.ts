import { contextBridge, ipcRenderer } from "electron";
import {
  API_INVOKE,
  API_SEND,
  API_EVENTS,
  type ElectronAPI,
} from "@/common/ipc-contract";

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

// One ipcRenderer listener per channel, fanned out to renderer subscribers.
// Subscriber counts scale with mounted components (every TerminalPanel, the
// Run/Build tabs, several stores…) and one raw listener each trips Node's
// MaxListenersExceededWarning past 10 — so raw listener count must be bounded
// by channels, not by subscribers.
for (const [method, channel] of Object.entries(API_EVENTS)) {
  const subscribers = new Set<(...args: unknown[]) => void>();
  ipcRenderer.on(channel, (_event, ...args) => {
    // Snapshot so a callback that (un)subscribes mid-dispatch can't change
    // who receives this event.
    for (const cb of [...subscribers]) cb(...args);
  });
  api[method] = (cb: (...args: unknown[]) => void) => {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  };
}

contextBridge.exposeInMainWorld("electronAPI", api as ElectronAPI);
