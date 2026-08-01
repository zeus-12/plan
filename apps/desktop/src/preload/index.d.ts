import type { ElectronAPI } from "@/common/ipc-contract";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
