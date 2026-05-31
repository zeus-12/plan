import type {
  ParsedSession,
  GitDiffResult,
  ProjectEntry,
  SessionListEntry,
  SessionEvent,
  FileContents,
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
  commit: (
    encoded: string,
    message: string,
    subPath?: string
  ) => Promise<GitOpResult>;
  applyPatch: (
    encoded: string,
    patch: string,
    mode: "stage" | "unstage" | "discard",
    subPath?: string
  ) => Promise<GitOpResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
