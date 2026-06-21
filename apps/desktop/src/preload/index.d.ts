import type {
  ParsedSession,
  GitDiffResult,
  ProjectEntry,
  SessionListEntry,
  SessionEvent,
  FileContents,
  FileView,
  GitStatusResult,
  GitOpResult,
  DiscoveredRepo,
  SearchOptions,
  SearchResult,
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
  listProjectFiles: (encoded: string) => Promise<string[]>;
  readProjectFile: (
    encoded: string,
    relPath: string
  ) => Promise<{ text: string; truncated: boolean; binary: boolean } | null>;
  projectFilePath: (
    encoded: string,
    relPath: string
  ) => Promise<string | null>;
  searchProjectFiles: (
    encoded: string,
    query: string,
    opts: SearchOptions
  ) => Promise<SearchResult>;
  onWatcherEvent: (cb: (e: SessionEvent) => void) => () => void;
  onSwitcherCycle: (
    cb: (e: { key: string; shift: boolean }) => void
  ) => () => void;
  addManualProject: () => Promise<ProjectEntry | null>;
  setProjectArchived: (
    encoded: string,
    archived: boolean
  ) => Promise<{ ok: true }>;
  setSessionArchived: (
    sessionId: string,
    archived: boolean
  ) => Promise<{ ok: true }>;
  renameSession: (sessionId: string, name: string) => Promise<{ ok: true }>;

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
    id: string,
    encoded: string,
    cols: number,
    rows: number,
    initialCommand?: string
  ) => Promise<{ cwd: string; error?: string }>;
  terminalInput: (id: string, data: string) => void;
  terminalSubmit: (id: string, text: string, imagePaths?: string[]) => void;
  terminalSendKeys: (id: string, keys: string[]) => void;
  terminalStatus: (
    id: string
  ) => Promise<{ running: boolean; process: string | null }>;
  terminalInputState: (
    id: string
  ) => Promise<{
    state: "input" | "selection" | "unknown";
    lines: string[];
  }>;
  terminalDump: (id: string) => Promise<string>;
  terminalResize: (id: string, cols: number, rows: number) => void;
  terminalKill: (id: string) => void;
  terminalList: () => Promise<{ id: string; cwd: string; pid: number }[]>;
  saveTempImage: (data: Uint8Array, ext: string) => Promise<string | null>;
  onTerminalData: (
    cb: (chunk: { id: string; data: string }) => void
  ) => () => void;
  onTerminalExit: (cb: (id: string) => void) => () => void;
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
