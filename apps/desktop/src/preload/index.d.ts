import type {
  ParsedSession,
  GitDiffResult,
  ProjectEntry,
  SessionListEntry,
  SessionEvent,
  FileContents,
  FileView,
  Plan,
  PlansEvent,
  GitStatusResult,
  GitOpResult,
  DiscoveredRepo,
} from "../shared-types";

interface ElectronAPI {
  listProjects: () => Promise<ProjectEntry[]>;
  listSessions: (encoded: string) => Promise<SessionListEntry[]>;
  readSession: (
    encoded: string,
    sessionId: string
  ) => Promise<ParsedSession | null>;
  getDiff: (encoded: string, subPath?: string) => Promise<GitDiffResult>;
  getFileContents: (
    encoded: string,
    oldPath: string | null,
    newPath: string | null,
    subPath?: string
  ) => Promise<FileContents>;
  listRepos: (encoded: string) => Promise<DiscoveredRepo[]>;
  getFileView: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath?: string
  ) => Promise<FileView>;
  onWatcherEvent: (cb: (e: SessionEvent) => void) => () => void;
  addManualProject: () => Promise<ProjectEntry | null>;
  setProjectArchived: (
    encoded: string,
    archived: boolean
  ) => Promise<{ ok: true }>;

  listPlans: () => Promise<Plan[]>;
  markPlanRead: (filePath: string) => Promise<{ ok: true }>;
  onPlansEvent: (cb: (e: PlansEvent) => void) => () => void;

  getBranch: (encoded: string, subPath?: string) => Promise<string | null>;
  getGitStatus: (encoded: string, subPath?: string) => Promise<GitStatusResult>;
  stageFile: (
    encoded: string,
    path: string,
    subPath?: string
  ) => Promise<GitOpResult>;
  unstageFile: (
    encoded: string,
    path: string,
    subPath?: string
  ) => Promise<GitOpResult>;
  discardFile: (
    encoded: string,
    path: string,
    subPath?: string
  ) => Promise<GitOpResult>;
  stageAll: (encoded: string, subPath?: string) => Promise<GitOpResult>;
  unstageAll: (encoded: string, subPath?: string) => Promise<GitOpResult>;
  discardAll: (encoded: string, subPath?: string) => Promise<GitOpResult>;
  stashAll: (encoded: string, subPath?: string) => Promise<GitOpResult>;
  push: (encoded: string, subPath?: string) => Promise<GitOpResult>;

  terminalOpen: (
    encoded: string,
    cols: number,
    rows: number
  ) => Promise<{ cwd: string }>;
  terminalInput: (encoded: string, data: string) => void;
  terminalResize: (encoded: string, cols: number, rows: number) => void;
  terminalKill: (encoded: string) => void;
  onTerminalData: (
    cb: (chunk: { encoded: string; data: string }) => void
  ) => () => void;
  onTerminalExit: (cb: (encoded: string) => void) => () => void;
  commit: (
    encoded: string,
    message: string,
    subPath?: string
  ) => Promise<GitOpResult>;
  applyPatch: (
    encoded: string,
    patch: string,
    mode: "stage" | "unstage" | "discard" | "apply",
    subPath?: string
  ) => Promise<GitOpResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
