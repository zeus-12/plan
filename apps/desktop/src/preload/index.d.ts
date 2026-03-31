import type { PlanVersion } from "@plan/shared/lib/store";

interface AutoInitData {
  file: string;
  versions: PlanVersion[];
  pendingContent: string | null;
}

interface ElectronAPI {
  getInit: () => Promise<AutoInitData | null>;
  onAutoContent: (callback: (content: string) => void) => () => void;
  saveSession: (filePath: string, versions: PlanVersion[]) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
