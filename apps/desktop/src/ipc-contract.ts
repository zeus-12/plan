/**
 * The IPC contract between main and the renderer — the single source of truth
 * for every channel's name, argument tuple, and result type.
 *
 * Everything else derives from this file, so the layers cannot drift:
 *   - main/index.ts implements a handler table typed `{[K in keyof
 *     IpcInvokeContract]: …}` — a missing/extra/mistyped handler is a compile
 *     error.
 *   - preload/index.ts builds `window.electronAPI` mechanically from the
 *     API_* maps below.
 *   - The renderer's `ElectronAPI` type (preload/index.d.ts) is the mapped
 *     type at the bottom of this file.
 *
 * Adding an endpoint = one entry in the matching contract interface + one
 * entry in the matching API_* map + one handler in main's table.
 *
 * Only type-erasable imports plus the API_* name maps live here — no Electron
 * or Node imports, so the renderer program can safely include this file.
 */

import type {
  AddReposToWorktreeInput,
  BlameResult,
  ClaudeConfigBundle,
  CommitDetails,
  CreatePrInput,
  CreatePrResult,
  CreateWorktreeInput,
  DiscoveredRepo,
  FileContents,
  FileImageDiff,
  FileView,
  GitDiffResult,
  GitOpResult,
  GitStatusResult,
  PrConversationResult,
  PrDiffResult,
  PrHeadShaResult,
  PrMetaResult,
  PrListResult,
  PrFileView,
  ProjectDefaults,
  ProjectEntry,
  ProjectFile,
  ScratchData,
  SearchOptions,
  SearchResult,
  SessionDelta,
  SessionDeltaClient,
  SessionEvent,
  SessionListEntry,
  SkillInfo,
  TerminalActivity,
  TerminalChunk,
  TerminalInfo,
  TerminalInputState,
  UpdateInfo,
  WorktreeRecord,
} from "./shared-types";

/** Request/response channels: `ipcRenderer.invoke` ↔ `ipcMain.handle`. */
export interface IpcInvokeContract {
  // Projects & sessions
  "projects:list": { args: []; result: ProjectEntry[] };
  /** file:// icon URLs keyed by encoded cwd; projects with no icon are absent. */
  "projects:icons": {
    args: [encodeds: string[]];
    result: Record<string, string>;
  };
  /** Opens the OS folder picker; null when the user cancels. */
  "projects:addManual": { args: []; result: ProjectEntry | null };
  "projects:setArchived": {
    args: [encoded: string, archived: boolean];
    result: { ok: true };
  };
  "projects:listSessions": {
    args: [encoded: string];
    result: SessionListEntry[];
  };
  "sessions:setArchived": {
    args: [sessionId: string, archived: boolean];
    result: { ok: true };
  };
  "sessions:rename": {
    args: [sessionId: string, name: string];
    result: { ok: true };
  };
  /** Incremental transcript read: pass the previous response's `gen` +
   *  held-message count to receive only the messages appended since. */
  "session:read": {
    args: [encoded: string, sessionId: string, client?: SessionDeltaClient];
    result: SessionDelta | null;
  };
  /** Kills the source chat's pty, then moves the transcript across projects. */
  "session:move": {
    args: [sessionId: string, fromEncoded: string, toEncoded: string];
    result: void;
  };

  // Working-tree content
  "project:diff": {
    args: [encoded: string, subPath?: string];
    result: GitDiffResult;
  };
  "project:fileContents": {
    args: [
      encoded: string,
      oldPath: string | null,
      newPath: string | null,
      subPath?: string,
    ];
    result: FileContents;
  };
  "project:fileView": {
    args: [
      encoded: string,
      path: string,
      mode: "staged" | "unstaged",
      subPath?: string,
    ];
    result: FileView;
  };
  "project:fileImageDiff": {
    args: [
      encoded: string,
      path: string,
      mode: "staged" | "unstaged",
      subPath?: string,
    ];
    result: FileImageDiff;
  };

  // GitHub PR viewer
  "github:listPrs": {
    args: [encoded: string, subPath?: string];
    result: PrListResult;
  };
  "github:prMeta": {
    args: [encoded: string, subPath: string, number: number];
    result: PrMetaResult;
  };
  "github:prConversation": {
    args: [encoded: string, subPath: string, number: number];
    result: PrConversationResult;
  };
  "github:prDiff": {
    args: [encoded: string, subPath: string, number: number];
    result: PrDiffResult;
  };
  "github:prHeadSha": {
    args: [encoded: string, subPath: string, number: number];
    result: PrHeadShaResult;
  };
  "github:prFileView": {
    args: [
      encoded: string,
      subPath: string,
      headSha: string | null,
      newPath: string | null,
    ];
    result: PrFileView;
  };

  // Project files / skills / Claude config
  "files:list": { args: [encoded: string]; result: string[] };
  "files:read": {
    args: [encoded: string, relPath: string];
    result: ProjectFile | null;
  };
  "files:path": {
    args: [encoded: string, relPath: string];
    result: string | null;
  };
  "files:search": {
    args: [encoded: string, query: string, opts: SearchOptions];
    result: SearchResult;
  };
  "skills:list": { args: [encoded: string]; result: SkillInfo[] };
  /** Resolve the global + project CLAUDE.md cascade and per-project memory. */
  "claudeConfig:read": {
    args: [encoded: string | null];
    result: ClaudeConfigBundle;
  };
  /** Write one Claude config/memory file (guarded to those paths in main). */
  "claudeConfig:write": {
    args: [path: string, text: string];
    result: { ok: true };
  };

  // Repos & worktrees
  "repos:list": { args: [encoded: string]; result: DiscoveredRepo[] };
  "repos:branches": {
    args: [encoded: string];
    /** subPath → that repo's remote branch names (for base autocomplete). */
    result: Record<string, string[]>;
  };
  "worktrees:list": { args: [encoded: string]; result: WorktreeRecord[] };
  "worktrees:listAll": { args: []; result: WorktreeRecord[] };
  "worktrees:create": {
    args: [encoded: string, input: CreateWorktreeInput];
    result: WorktreeRecord;
  };
  "worktrees:remove": { args: [id: string]; result: void };
  "worktrees:addRepos": {
    args: [id: string, input: AddReposToWorktreeInput];
    result: WorktreeRecord;
  };
  "worktrees:createPr": {
    args: [id: string, input: CreatePrInput];
    result: CreatePrResult;
  };
  "worktrees:getDefaults": {
    args: [encoded: string];
    result: ProjectDefaults;
  };
  "worktrees:setDefaults": {
    args: [encoded: string, defaults: ProjectDefaults];
    result: void;
  };
  // Scoped to the mounted workspace; renderer calls these on mount/unmount.
  "worktree:watch": { args: [encoded: string]; result: void };
  "worktree:unwatch": { args: [encoded: string]; result: void };

  // Git
  "git:branch": {
    args: [encoded: string, subPath?: string];
    result: string | null;
  };
  "git:status": {
    args: [encoded: string, subPath?: string];
    result: GitStatusResult;
  };
  "git:stage": {
    args: [encoded: string, path: string, subPath?: string];
    result: GitOpResult;
  };
  "git:unstage": {
    args: [encoded: string, path: string, subPath?: string];
    result: GitOpResult;
  };
  "git:discard": {
    args: [encoded: string, path: string, subPath?: string];
    result: GitOpResult;
  };
  "git:stageAll": {
    args: [encoded: string, subPath?: string];
    result: GitOpResult;
  };
  "git:unstageAll": {
    args: [encoded: string, subPath?: string];
    result: GitOpResult;
  };
  "git:discardAll": {
    args: [encoded: string, subPath?: string];
    result: GitOpResult;
  };
  "git:stashAll": {
    args: [encoded: string, subPath?: string];
    result: GitOpResult;
  };
  "git:push": {
    args: [encoded: string, subPath?: string];
    result: GitOpResult;
  };
  "git:commit": {
    args: [encoded: string, message: string, subPath?: string];
    result: GitOpResult;
  };
  "git:applyPatch": {
    args: [
      encoded: string,
      patch: string,
      mode: "stage" | "unstage" | "discard" | "apply",
      subPath?: string,
    ];
    result: GitOpResult;
  };
  /**
   * Per-line authorship for `contents`, blamed as the file's working-tree
   * version — callers pass exactly the text they render, so the result can
   * never drift from what's on screen. Null: untracked / no repo.
   */
  "git:blameContents": {
    args: [encoded: string, relPath: string, contents: string];
    result: BlameResult | null;
  };
  /**
   * Per-line authorship for the file AS OF `rev` — for viewers rendering a
   * committed blob (e.g. a PR head fetched into the local object store).
   */
  "git:blameRev": {
    args: [encoded: string, relPath: string, rev: string];
    result: BlameResult | null;
  };
  /** Full message for one commit (for the blame hover card). */
  "git:commitDetails": {
    args: [encoded: string, relPath: string, hash: string];
    result: CommitDetails | null;
  };

  // Terminal ptys (keyed by terminal id; cwd resolved from encoded in main)
  "terminal:open": {
    args: [
      id: string,
      encoded: string,
      cols: number,
      rows: number,
      initialCommand?: string,
      subPath?: string,
    ];
    result: { cwd: string; error?: string };
  };
  "terminal:status": {
    args: [id: string];
    result: { running: boolean; process: string | null };
  };
  "terminal:inputState": {
    args: [id: string];
    result: { state: TerminalInputState; lines: string[] };
  };
  /** Ids of every live pty currently showing Claude's "esc to interrupt" hint. */
  "terminal:busyIds": { args: []; result: string[] };
  /** Ids of every live pty parked on a selection/approval menu (agent live). */
  "terminal:selectionIds": { args: []; result: string[] };
  "terminal:list": { args: []; result: TerminalInfo[] };
  /**
   * Re-key a live pty from `oldId` to `newId` in place (same process, same
   * scrollback). Used when a chat's `claude` migrates to a different session id
   * (e.g. `/branch` forks A into B): the pty that was `chat:enc:A` is really
   * driving B now, so we rename it to `chat:enc:B` instead of leaving the UI
   * bound to a session the process left. Returns false if no pty exists under
   * `oldId` or one already exists under `newId`.
   */
  "terminal:rekey": {
    args: [oldId: string, newId: string];
    result: boolean;
  };
  /** Write a pasted image to a temp file; null when the write fails. */
  "terminal:saveTempImage": {
    args: [data: Uint8Array, ext: string];
    result: string | null;
  };
  /** Does a path still exist on disk? (Restored drafts verify pasted images.) */
  "terminal:fileExists": { args: [path: string]; result: boolean };

  // Updates (notify-only — see main/updates.ts)
  /** Resolves to a newer release, or null when up to date / offline. */
  "updates:check": { args: []; result: UpdateInfo | null };
  /** Opens the release download page in the user's browser. */
  "updates:openDownload": { args: [url: string]; result: void };

  // Per-worktree scratchpad
  "scratch:read": { args: [encoded: string]; result: ScratchData | null };
  "scratch:write": { args: [encoded: string, data: ScratchData]; result: void };
}

/** Fire-and-forget renderer→main channels: `ipcRenderer.send` ↔ `ipcMain.on`. */
export interface IpcSendContract {
  "terminal:input": [id: string, data: string];
  "terminal:submit": [id: string, text: string, imagePaths?: string[]];
  "terminal:sendKeys": [id: string, keys: string[]];
  "terminal:resize": [id: string, cols: number, rows: number];
  "terminal:kill": [id: string];
}

/** Main→renderer push channels: `webContents.send` ↔ `ipcRenderer.on`. */
export interface IpcEventContract {
  "watcher:event": [e: SessionEvent];
  /** Ctrl+Tab / Ctrl+` cycle forwarded from main's before-input-event. */
  "switcher:cycle": [e: { key: string; shift: boolean }];
  /** ⌘R pressed; renderer force-refreshes a data page or reloads the app. */
  "app:reload-request": [];
  "terminal:data": [chunk: TerminalChunk];
  "terminal:exit": [id: string];
  /** Pushed when a pty's busy/menu state changes (evaluated on output). */
  "terminal:activity": [id: string, activity: TerminalActivity];
}

// ── window.electronAPI surface ───────────────────────────────────────
// Method name → channel. preload builds the real object from these maps, and
// the ElectronAPI type below is derived from them — so a method can't exist
// without a channel, point at an unknown channel, or disagree on types.

export const API_INVOKE = {
  listProjects: "projects:list",
  getProjectIcons: "projects:icons",
  addManualProject: "projects:addManual",
  setProjectArchived: "projects:setArchived",
  listSessions: "projects:listSessions",
  setSessionArchived: "sessions:setArchived",
  renameSession: "sessions:rename",
  readSession: "session:read",
  moveSession: "session:move",

  getDiff: "project:diff",
  getFileContents: "project:fileContents",
  getFileView: "project:fileView",
  getFileImageDiff: "project:fileImageDiff",

  listPrs: "github:listPrs",
  getPrMeta: "github:prMeta",
  getPrConversation: "github:prConversation",
  getPrDiff: "github:prDiff",
  getPrHeadSha: "github:prHeadSha",
  getPrFileView: "github:prFileView",

  listProjectFiles: "files:list",
  readProjectFile: "files:read",
  projectFilePath: "files:path",
  searchProjectFiles: "files:search",
  listSkills: "skills:list",
  readClaudeConfig: "claudeConfig:read",
  writeClaudeConfig: "claudeConfig:write",

  listRepos: "repos:list",
  listRepoBranches: "repos:branches",
  listWorktrees: "worktrees:list",
  listAllWorktrees: "worktrees:listAll",
  createWorktree: "worktrees:create",
  removeWorktree: "worktrees:remove",
  addReposToWorktree: "worktrees:addRepos",
  createWorktreePr: "worktrees:createPr",
  getWorktreeDefaults: "worktrees:getDefaults",
  setWorktreeDefaults: "worktrees:setDefaults",
  watchWorktree: "worktree:watch",
  unwatchWorktree: "worktree:unwatch",

  getBranch: "git:branch",
  getGitStatus: "git:status",
  stageFile: "git:stage",
  unstageFile: "git:unstage",
  discardFile: "git:discard",
  stageAll: "git:stageAll",
  unstageAll: "git:unstageAll",
  discardAll: "git:discardAll",
  stashAll: "git:stashAll",
  push: "git:push",
  commit: "git:commit",
  applyPatch: "git:applyPatch",
  blameContents: "git:blameContents",
  blameRev: "git:blameRev",
  commitDetails: "git:commitDetails",

  terminalOpen: "terminal:open",
  terminalStatus: "terminal:status",
  terminalInputState: "terminal:inputState",
  terminalBusyIds: "terminal:busyIds",
  terminalSelectionIds: "terminal:selectionIds",
  terminalList: "terminal:list",
  terminalRekey: "terminal:rekey",
  saveTempImage: "terminal:saveTempImage",
  fileExists: "terminal:fileExists",

  checkForUpdate: "updates:check",
  openUpdateDownload: "updates:openDownload",

  readScratch: "scratch:read",
  writeScratch: "scratch:write",
} as const satisfies Record<string, keyof IpcInvokeContract>;

export const API_SEND = {
  terminalInput: "terminal:input",
  terminalSubmit: "terminal:submit",
  terminalSendKeys: "terminal:sendKeys",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
} as const satisfies Record<string, keyof IpcSendContract>;

export const API_EVENTS = {
  onWatcherEvent: "watcher:event",
  onSwitcherCycle: "switcher:cycle",
  onReloadRequest: "app:reload-request",
  onTerminalData: "terminal:data",
  onTerminalExit: "terminal:exit",
  onTerminalActivity: "terminal:activity",
} as const satisfies Record<string, keyof IpcEventContract>;

/** The renderer-facing API, derived method-by-method from the maps above.
 *  Event subscriptions return an unsubscribe function. */
export type ElectronAPI = {
  [M in keyof typeof API_INVOKE]: (
    ...args: IpcInvokeContract[(typeof API_INVOKE)[M]]["args"]
  ) => Promise<IpcInvokeContract[(typeof API_INVOKE)[M]]["result"]>;
} & {
  [M in keyof typeof API_SEND]: (
    ...args: IpcSendContract[(typeof API_SEND)[M]]
  ) => void;
} & {
  [M in keyof typeof API_EVENTS]: (
    cb: (...args: IpcEventContract[(typeof API_EVENTS)[M]]) => void,
  ) => () => void;
};
