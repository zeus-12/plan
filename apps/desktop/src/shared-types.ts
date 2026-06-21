/** Types shared between main and renderer. No runtime imports allowed here. */

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use";
      id: string;
      tool: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      output: string;
      isError?: boolean;
    };

export interface ConversationMessage {
  uuid: string;
  parentUuid: string | null;
  role: "user" | "assistant";
  timestamp: string;
  parts: MessagePart[];
}

export interface SessionMeta {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}

export interface ParsedSession {
  meta: SessionMeta;
  messages: ConversationMessage[];
}

export interface GitDiffResult {
  available: boolean;
  diff: string;
  error?: string;
}

export interface FileContents {
  oldText: string;
  newText: string;
  binary: boolean;
}

export interface FileView {
  oldText: string;
  newText: string;
  diffBody: string;
  binary: boolean;
}

/** Match options for the project-wide Search tab (mirrors VS Code's toggles). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One matching line within a file (a single line can hold several matches). */
export interface SearchMatch {
  /** 1-based line number. */
  line: number;
  /** The raw line text (for the result preview). */
  text: string;
  /** Char-offset ranges of every match within `text`. */
  ranges: { start: number; end: number }[];
}

export interface SearchFileResult {
  /** Project-relative POSIX path. */
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFileResult[];
  totalMatches: number;
  /** True when a cap (files scanned or matches collected) cut the results off. */
  truncated: boolean;
  /** Set when the query is an invalid regex; `files` is then empty. */
  error?: string;
}

export interface ProjectEntry {
  encoded: string;
  cwd: string;
  mtimeMs: number;
  archived: boolean;
}

export interface SessionListEntry {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  archived: boolean;
  title: string | null;
  messageCount: number;
  updatedAt: number | string | null;
}

export type SessionEventKind = "new-session" | "session-changed" | "project-added";

export interface SessionEvent {
  kind: SessionEventKind;
  encoded: string;
  sessionId?: string;
  filePath?: string;
}

export interface GitFileStatus {
  path: string;
  staged: boolean;
  unstaged: boolean;
  code: string;
}

export interface GitStatusResult {
  available: boolean;
  branch: string | null;
  files: GitFileStatus[];
  /** Commits ahead of upstream (0 when none / no upstream). */
  ahead: number;
  /** Whether the branch has an upstream configured. */
  hasUpstream: boolean;
}

export interface GitOpResult {
  ok: boolean;
  error?: string;
}

export interface DiscoveredRepo {
  /** Absolute repo root. */
  path: string;
  /** Path relative to the project cwd. "" for root-level repos. */
  subPath: string;
  /** Canonical git dir; equal across worktrees of the same source repo. */
  commonDir: string;
  branch: string | null;
}

/** One repo's checkout within a worktree ("" subPath for single-repo projects). */
export interface WorktreeRepoRecord {
  subPath: string;
  /** Absolute path to this repo's worktree checkout (under ~/.plan/worktrees/…). */
  path: string;
  branch: string;
  base: string;
}

export interface WorktreeRecord {
  id: string;
  /** Claude-encoded project cwd this worktree belongs to. */
  projectEncoded: string;
  name: string;
  /** Absolute root dir holding this worktree's repo checkouts. */
  rootPath: string;
  /**
   * Encoded key for the worktree's own cwd (rootPath). The workspace swaps to
   * this so all `(encoded, subPath)` content ops scope to the worktree.
   */
  encoded: string;
  repos: WorktreeRepoRecord[];
  createdAt: number;
}

/** Per-project defaults the user sets once; pre-fill new worktrees + terminals. */
export interface ProjectDefaults {
  base?: string;
  branchPrefix?: string;
  /** subPath → setup command (run once on worktree creation). */
  setup?: Record<string, string>;
  /** subPath → run command (the long-lived dev server). */
  run?: Record<string, string>;
}

export interface CreateWorktreeInput {
  name: string;
  branch: string;
  base: string;
}

/** Fields the user approves in the Create PR modal before `gh pr create` runs. */
export interface CreatePrInput {
  title: string;
  body: string;
  base: string;
}

/** Outcome of opening a PR for one repo in a worktree. */
export interface CreatePrRepoResult {
  subPath: string;
  /** Human label for the repo ("repo root" or its subPath). */
  label: string;
  /** PR URL when created (or already open). */
  url?: string;
  /** True when the PR already existed and we returned its URL. */
  existed?: boolean;
  /** Failure reason for this repo (push or gh error). */
  error?: string;
}

export interface CreatePrResult {
  repos: CreatePrRepoResult[];
}
