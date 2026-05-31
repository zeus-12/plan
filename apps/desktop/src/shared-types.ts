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
}

export type SessionEventKind = "new-session" | "session-changed" | "project-added";

export interface SessionEvent {
  kind: SessionEventKind;
  encoded: string;
  sessionId?: string;
  filePath?: string;
}

export interface PlanVersion {
  id: string;
  text: string;
  createdAt: number;
}

export interface Plan {
  filePath: string;
  versions: PlanVersion[];
  unread: number;
  updatedAt: number;
}

export type PlansEventKind = "new-plan" | "plan-changed" | "plan-removed";

export interface PlansEvent {
  kind: PlansEventKind;
  filePath: string;
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
