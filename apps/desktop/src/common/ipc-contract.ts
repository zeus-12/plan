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
  ChatActivity,
  ChatEngineDescriptor,
  ChatStatus,
  StartChatOptions,
  StartChatResult,
} from "./chat-engines";
import type {
  AddReposToWorktreeInput,
  BlameResult,
  ClaudeConfigBundle,
  CommitDetails,
  CreatePrInput,
  CreatePrResult,
  CreateWorktreeInput,
  DiscoveredRepo,
  ExternalApp,
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
  PushPreview,
  ProjectFile,
  ScratchData,
  SearchOptions,
  SearchResult,
  SentFile,
  SessionDelta,
  SessionDeltaClient,
  SessionEvent,
  SessionListEntry,
  SkillInfo,
  TerminalChunk,
  TerminalDebugFrame,
  TerminalInfo,
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
  /** Head of a file the agent sent, by absolute path — bounded at the read,
   *  so hovering a row never loads a large file. Null when it can't be read. */
  "files:readSent": { args: [path: string]; result: SentFile | null };
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
  /** Read-only: what `git:push` would send, for the push dialog. */
  "git:pushPreview": {
    args: [encoded: string, subPath?: string];
    result: PushPreview;
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
  /** Full message + hosting-service link for one commit (blame hover card). */
  "git:commitDetails": {
    args: [encoded: string, relPath: string, hash: string];
    result: CommitDetails | null;
  };
  /** Open a commit page (a `CommitDetails.url`) in the user's browser. */
  "git:openCommit": { args: [url: string]; result: void };

  // Chat engines (keyed by chat id — see chat-engines.ts / terminal-ids.ts).
  // These are the driver-level operations: which engines exist, and how to
  // start, feed, inspect, and end a Claude session. Which engine is behind a
  // given chat is main's business; every channel here is engine-agnostic.
  /** Every registered engine, with its capabilities (drives the UI's gating). */
  "chat:engines": { args: []; result: ChatEngineDescriptor[] };
  /** Start driving a chat, or reattach if it's already live. */
  "chat:start": {
    args: [chatId: string, opts: StartChatOptions];
    result: StartChatResult;
  };
  "chat:status": { args: [chatId: string]; result: ChatStatus };
  /** Re-read right now whether this chat is parked waiting on the user. */
  "chat:probeApproval": { args: [chatId: string]; result: boolean };
  /** Chat ids mid-turn across every engine. */
  "chat:busyIds": { args: []; result: string[] };
  /** Chat ids parked waiting on the user across every engine. */
  "chat:approvalIds": { args: []; result: string[] };
  /**
   * Follow a chat whose session id changed under it — a `/branch` fork keeps
   * the same driver but starts writing a new transcript, so the driver
   * registered under `chat:enc:A` is really on B now. Returns false when the
   * engine can't do it or there was nothing to move, in which case the caller
   * must not repoint the UI.
   */
  "chat:rekey": {
    args: [oldChatId: string, newChatId: string];
    result: boolean;
  };

  // Terminal ptys (keyed by terminal id; cwd resolved from encoded in main).
  // Scratch shells, Run/Build commands, and — for engines that have one — the
  // pane attached to a chat's pty. Pure terminal surface: no chat semantics.
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
  /** Whether a pty is alive. Whether an AGENT is live inside one is a chat
   *  question — see `chat:status`, which the owning engine answers. */
  "terminal:status": {
    args: [id: string];
    result: { running: boolean };
  };
  "terminal:list": { args: []; result: TerminalInfo[] };
  /** Write a pasted image to a temp file; null when the write fails. */
  "terminal:saveTempImage": {
    args: [data: Uint8Array, ext: string];
    result: string | null;
  };
  /** Does a path still exist on disk? (Restored drafts verify pasted images.) */
  "terminal:fileExists": { args: [path: string]; result: boolean };
  /** Debug menu: what main's emulator has on screen for this pty, plus how the
   *  Claude-TUI heuristics classify it. See main/debug/terminal-frame.ts. */
  "terminal:debugFrame": {
    args: [id: string];
    result: TerminalDebugFrame;
  };

  // Updates (notify-only — see main/updates.ts)
  /** Resolves to a newer release, or null when up to date / offline. */
  "updates:check": { args: []; result: UpdateInfo | null };
  /** Opens the release download page in the user's browser. */
  "updates:openDownload": { args: [url: string]; result: void };

  // "Open in…" — external macOS apps. Targets are addressed the same way as
  // every other workspace path (encoded + optional subPath + optional relPath),
  // so main resolves the absolute path and the renderer never holds one.
  /** Apps confirmed installed. Empty off macOS. */
  "apps:list": { args: []; result: ExternalApp[] };
  "apps:open": {
    args: [
      appId: string,
      encoded: string,
      relPath: string | null,
      subPath?: string,
    ];
    result: { ok: boolean; error?: string };
  };
  /** Absolute path for a target — backs the menu's "Copy path". */
  "apps:resolvePath": {
    args: [encoded: string, relPath: string | null, subPath?: string];
    result: string;
  };
  /** Launch an absolute path. Only for files the transcript already names —
   *  a sent file lives outside every workspace, so nothing can resolve it. */
  "apps:openPath": {
    args: [appId: string, path: string];
    result: { ok: boolean; error?: string };
  };

  // Per-worktree scratchpad
  "scratch:read": { args: [encoded: string]; result: ScratchData | null };
  "scratch:write": { args: [encoded: string, data: ScratchData]; result: void };
}

/** Fire-and-forget renderer→main channels: `ipcRenderer.send` ↔ `ipcMain.on`. */
export interface IpcSendContract {
  /** Deliver a user message to a chat's agent and submit it. */
  "chat:send": [chatId: string, text: string, imagePaths?: string[]];
  /** Answer an on-screen TUI selector (engines with `keystrokes` only). */
  "chat:sendKeys": [chatId: string, keys: string[]];
  "chat:stop": [chatId: string];

  "terminal:input": [id: string, data: string];
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
  /** Pushed when a chat's busy / waiting-on-you pair changes. */
  "chat:activity": [chatId: string, activity: ChatActivity];
  /** A chat's driver ended (quit, killed, or died). */
  "chat:exit": [chatId: string];
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
  readSentFile: "files:readSent",
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
  pushPreview: "git:pushPreview",
  push: "git:push",
  commit: "git:commit",
  applyPatch: "git:applyPatch",
  blameContents: "git:blameContents",
  blameRev: "git:blameRev",
  commitDetails: "git:commitDetails",
  openCommit: "git:openCommit",

  listChatEngines: "chat:engines",
  startChat: "chat:start",
  chatStatus: "chat:status",
  probeChatApproval: "chat:probeApproval",
  busyChatIds: "chat:busyIds",
  approvalChatIds: "chat:approvalIds",
  rekeyChat: "chat:rekey",

  terminalOpen: "terminal:open",
  terminalStatus: "terminal:status",
  terminalList: "terminal:list",
  saveTempImage: "terminal:saveTempImage",
  fileExists: "terminal:fileExists",
  terminalDebugFrame: "terminal:debugFrame",

  checkForUpdate: "updates:check",
  openUpdateDownload: "updates:openDownload",

  listExternalApps: "apps:list",
  openInExternalApp: "apps:open",
  openPathInExternalApp: "apps:openPath",
  resolveTargetPath: "apps:resolvePath",

  readScratch: "scratch:read",
  writeScratch: "scratch:write",
} as const satisfies Record<string, keyof IpcInvokeContract>;

export const API_SEND = {
  sendToChat: "chat:send",
  sendKeysToChat: "chat:sendKeys",
  stopChat: "chat:stop",

  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
} as const satisfies Record<string, keyof IpcSendContract>;

export const API_EVENTS = {
  onWatcherEvent: "watcher:event",
  onSwitcherCycle: "switcher:cycle",
  onReloadRequest: "app:reload-request",
  onTerminalData: "terminal:data",
  onTerminalExit: "terminal:exit",
  onChatActivity: "chat:activity",
  onChatExit: "chat:exit",
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
