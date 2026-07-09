import type { ElectronAPI } from "../ipc-contract";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
