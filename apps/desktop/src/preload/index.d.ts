import type {
  ParsedSession,
  GitDiffResult,
  ProjectEntry,
  SessionListEntry,
  SessionEvent,
  FileContents,
  FileView,
  FileImageDiff,
  GitStatusResult,
  GitOpResult,
  DiscoveredRepo,
  SearchOptions,
  SearchResult,
  WorktreeRecord,
  ProjectDefaults,
  CreateWorktreeInput,
  AddReposToWorktreeInput,
  CreatePrInput,
  CreatePrResult,
  SkillInfo,
  UpdateInfo,
  ClaudeConfigBundle,
} from "../shared-types";

interface ElectronAPI {
  listProjects: () => Promise<ProjectEntry[]>;
  listSessions: (encoded: string) => Promise<SessionListEntry[]>;
  readSession: (
    encoded: string,
    sessionId: string,
  ) => Promise<ParsedSession | null>;
  moveSession: (
    sessionId: string,
    fromEncoded: string,
    toEncoded: string,
  ) => Promise<void>;
  getDiff: (encoded: string, subPath?: string) => Promise<GitDiffResult>;
  getFileContents: (
    encoded: string,
    oldPath: string | null,
    newPath: string | null,
    subPath?: string,
  ) => Promise<FileContents>;
  listRepos: (encoded: string) => Promise<DiscoveredRepo[]>;

  listWorktrees: (encoded: string) => Promise<WorktreeRecord[]>;
  listAllWorktrees: () => Promise<WorktreeRecord[]>;
  createWorktree: (
    encoded: string,
    input: CreateWorktreeInput,
  ) => Promise<WorktreeRecord>;
  removeWorktree: (id: string) => Promise<void>;
  addReposToWorktree: (
    id: string,
    input: AddReposToWorktreeInput,
  ) => Promise<WorktreeRecord>;
  createWorktreePr: (
    id: string,
    input: CreatePrInput,
  ) => Promise<CreatePrResult>;
  getWorktreeDefaults: (encoded: string) => Promise<ProjectDefaults>;
  setWorktreeDefaults: (
    encoded: string,
    defaults: ProjectDefaults,
  ) => Promise<void>;
  getFileView: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath?: string,
  ) => Promise<FileView>;
  getFileImageDiff: (
    encoded: string,
    path: string,
    mode: "staged" | "unstaged",
    subPath?: string,
  ) => Promise<FileImageDiff>;
  listProjectFiles: (encoded: string) => Promise<string[]>;
  readProjectFile: (
    encoded: string,
    relPath: string,
  ) => Promise<{ text: string; truncated: boolean; binary: boolean } | null>;
  projectFilePath: (encoded: string, relPath: string) => Promise<string | null>;
  listSkills: (encoded: string) => Promise<SkillInfo[]>;
  /** Resolve the global + project CLAUDE.md cascade and per-project memory. */
  readClaudeConfig: (encoded: string | null) => Promise<ClaudeConfigBundle>;
  /** Write one Claude config/memory file (guarded to those paths in main). */
  writeClaudeConfig: (path: string, text: string) => Promise<{ ok: true }>;
  searchProjectFiles: (
    encoded: string,
    query: string,
    opts: SearchOptions,
  ) => Promise<SearchResult>;
  onWatcherEvent: (cb: (e: SessionEvent) => void) => () => void;
  watchWorktree: (encoded: string) => Promise<void>;
  unwatchWorktree: (encoded: string) => Promise<void>;
  onSwitcherCycle: (
    cb: (e: { key: string; shift: boolean }) => void,
  ) => () => void;
  addManualProject: () => Promise<ProjectEntry | null>;
  setProjectArchived: (
    encoded: string,
    archived: boolean,
  ) => Promise<{ ok: true }>;
  setSessionArchived: (
    sessionId: string,
    archived: boolean,
  ) => Promise<{ ok: true }>;
  renameSession: (sessionId: string, name: string) => Promise<{ ok: true }>;

  getBranch: (encoded: string, subPath?: string) => Promise<string | null>;
  getGitStatus: (encoded: string, subPath?: string) => Promise<GitStatusResult>;
  stageFile: (
    encoded: string,
    path: string,
    subPath?: string,
  ) => Promise<GitOpResult>;
  unstageFile: (
    encoded: string,
    path: string,
    subPath?: string,
  ) => Promise<GitOpResult>;
  discardFile: (
    encoded: string,
    path: string,
    subPath?: string,
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
    initialCommand?: string,
    subPath?: string,
  ) => Promise<{ cwd: string; error?: string }>;
  terminalInput: (id: string, data: string) => void;
  terminalSubmit: (id: string, text: string, imagePaths?: string[]) => void;
  terminalSendKeys: (id: string, keys: string[]) => void;
  terminalStatus: (
    id: string,
  ) => Promise<{ running: boolean; process: string | null }>;
  terminalInputState: (id: string) => Promise<{
    state: "input" | "selection" | "unknown";
    lines: string[];
  }>;
  terminalDump: (id: string) => Promise<string>;
  /** Ids of every live pty currently showing Claude's "esc to interrupt" hint. */
  terminalBusyIds: () => Promise<string[]>;
  terminalResize: (id: string, cols: number, rows: number) => void;
  terminalKill: (id: string) => void;
  terminalList: () => Promise<{ id: string; cwd: string; pid: number }[]>;
  saveTempImage: (data: Uint8Array, ext: string) => Promise<string | null>;
  fileExists: (path: string) => Promise<boolean>;
  onTerminalData: (
    cb: (chunk: { id: string; data: string }) => void,
  ) => () => void;
  onTerminalExit: (cb: (id: string) => void) => () => void;
  commit: (
    encoded: string,
    message: string,
    subPath?: string,
  ) => Promise<GitOpResult>;
  applyPatch: (
    encoded: string,
    patch: string,
    mode: "stage" | "unstage" | "discard" | "apply",
    subPath?: string,
  ) => Promise<GitOpResult>;

  /** Resolves to a newer release, or null when up to date / offline. */
  checkForUpdate: () => Promise<UpdateInfo | null>;
  /** Opens the release download page in the user's browser. */
  openUpdateDownload: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
