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
  /** True for harness-injected turns (skill bodies, context caveats, loop
   *  instructions) — these are machinery, not something the user typed, so the
   *  UI renders them as a muted system card rather than a user bubble. */
  isMeta?: boolean;
  /** "typed" = real user input; "system" = harness-injected (loop tick,
   *  task-notification re-injection). Absent on assistant turns. */
  promptSource?: "typed" | "system";
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

/** Absolute filesystem paths to the before/after image files for an image diff. */
export interface FileImageDiff {
  oldPath: string | null;
  newPath: string | null;
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

/** A skill/command invocable as `/name` in the Claude Code TUI. */
export interface SkillInfo {
  /** Invocation name without the leading slash, e.g. "code-review". */
  name: string;
  /** Frontmatter description (may be empty). */
  description: string;
  /** Where it was discovered — drives the menu badge. */
  source: "project" | "personal" | "plugin";
}

export interface SessionListEntry {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  archived: boolean;
  /** Display title: a user-assigned name if set, else the auto-derived title. */
  title: string | null;
  /**
   * The auto-derived title from the transcript, regardless of any user rename.
   * Lets search match the original name and the UI hint what a chat was called
   * before it was renamed. Equal to `title` when the chat hasn't been renamed.
   */
  derivedTitle: string | null;
  messageCount: number;
  updatedAt: number | string | null;
}

export type SessionEventKind =
  | "new-session"
  | "session-changed"
  | "project-added"
  // Emitted by worktree-watcher when the real repo on disk changes (file edit,
  // git stage/commit/checkout). Carries no sessionId — the renderer treats it
  // as "re-pull git + bump content revision for this project".
  | "worktree-changed";

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

/** One commit's identity as reported by `git blame --porcelain`. */
export interface BlameCommit {
  hash: string;
  author: string;
  /** Author email without the surrounding <>. */
  authorMail: string;
  /** Author time in epoch milliseconds. */
  authorTime: number;
  /** Commit subject (first line of the message). */
  summary: string;
}

/** All-zero hash git blame assigns to lines not yet committed. */
export const UNCOMMITTED_BLAME_HASH = "0".repeat(40);

export interface BlameResult {
  /** Commit hash per file line; index = line number − 1. */
  lineHashes: string[];
  commits: Record<string, BlameCommit>;
  /** The repo's user.email — lets the UI label the user's own commits "You". */
  userEmail: string | null;
}

/**
 * The blame hover card's lazy fetch: just the full commit message — author,
 * date, and hash are already on the BlameCommit the blame pass returned.
 */
export interface CommitDetails {
  /** Full commit message: subject + body. */
  message: string;
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
  /**
   * Legacy branch-prefix for new worktrees. No longer surfaced in the UI; kept
   * in the type so existing `worktrees.json` data round-trips.
   */
  branchPrefix?: string;
  /** subPath → setup command (run once on worktree creation). */
  setup?: Record<string, string>;
  /**
   * Legacy per-repo run map (subPath → dev-server command). Superseded by the
   * single project-level `runCommand` below; kept in the type so existing
   * `worktrees.json` data round-trips, but no longer surfaced in the UI.
   */
  run?: Record<string, string>;
  /**
   * Legacy single "Run" command. Superseded by `runCommands`; still read (and
   * migrated) so existing `worktrees.json` data keeps working, but no longer
   * written by the UI.
   */
  runCommand?: string;
  /** Legacy single build command (once prepended to the Run command). @see buildCommands */
  buildCommand?: string;
  /**
   * The "Run" terminal's command list — shared across all worktrees + sessions
   * of this project. Each entry runs in its own per-worktree pty
   * (`run:<encoded>:<entry.id>`) and gets its own sub-tab; "Run all" starts them
   * together. Absent = fall back to the legacy `runCommand`.
   */
  runCommands?: CommandEntry[];
  /**
   * The "Build" terminal's command list. Same shape as `runCommands`, surfaced
   * only inside a worktree (pty `build:<encoded>:<entry.id>`).
   */
  buildCommands?: CommandEntry[];
}

/**
 * One command in a Run/Build terminal's list. `subPath` targets a git sub-repo
 * of a multi-repo project (the command runs in that repo's dir); "" / undefined
 * runs it at the project root.
 */
export interface CommandEntry {
  /** Stable id — the pty key suffix + sub-tab key. Persisted so ptys survive reloads. */
  id: string;
  command: string;
  subPath?: string;
}

export interface CreateWorktreeInput {
  name: string;
  branch: string;
  /** Default base branch, used for any repo without an entry in `bases`. */
  base: string;
  /**
   * Per-repo base-branch overrides, keyed by repo subPath ("" = root repo).
   * Each value is a branch name resolved against that repo's remote — the
   * worktree forks from `<remote>/<base>`, never a possibly-stale local branch.
   * Lets a multi-repo worktree fork each repo from a branch that exists there.
   */
  bases?: Record<string, string>;
  /**
   * SubPaths of the repos this worktree should span. When omitted, every
   * discovered repo is included. Lets the user skip repos they won't touch (and
   * add them later via `addReposToWorktree`).
   */
  repos?: string[];
}

/** Add one or more not-yet-included repos to an existing worktree. */
export interface AddReposToWorktreeInput {
  /** subPath → base branch, for each repo to add to the worktree. */
  bases: Record<string, string>;
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
  /** True when the repo had no commits ahead of base — intentionally not a PR. */
  skipped?: boolean;
  /** Failure reason for this repo (push or gh error). */
  error?: string;
}

export interface CreatePrResult {
  repos: CreatePrRepoResult[];
}

// ── GitHub PR viewer ─────────────────────────────────────────────────────────
// Read-only browsing of a repo's pull requests via the `gh` CLI. Shapes mirror
// what `gh pr list` / `gh pr view` / the REST API actually return (verified),
// normalized to the fields the UI needs.

export type PrState = "OPEN" | "CLOSED" | "MERGED";
/** Rolled-up CI state; null when the PR has no checks at all. */
export type PrChecks = "success" | "failure" | "pending" | null;

/** One PR row in the sidebar list — cheap to fetch (`gh pr list`). */
export interface PrSummary {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  authorIsBot: boolean;
  /** ISO timestamp of the last update (drives stale-while-revalidate). */
  updatedAt: string;
  checks: PrChecks;
  url: string;
}

export interface PrListResult {
  /** True when the repo has a GitHub remote and `gh` could list its PRs. */
  available: boolean;
  prs: PrSummary[];
  error?: string;
}

/** What produced a timeline entry: a conversation comment, a review, or an
 * inline (code-anchored) review comment. */
export type PrCommentKind = "comment" | "review" | "review-comment";

export interface PrComment {
  kind: PrCommentKind;
  id: string;
  author: string;
  /** Reliable: derived from the REST `user.type === "Bot"`. */
  authorIsBot: boolean;
  body: string;
  createdAt: string;
  url: string;
  /** review only: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED. */
  reviewState?: string;
  /** review-comment only: file + line the note is anchored to. */
  path?: string;
  line?: number | null;
  /** review-comment only: the code snippet GitHub attaches to the note. */
  diffHunk?: string;
  /** review-comment only: parent id for threaded replies (null = top of thread). */
  inReplyToId?: string | null;
}

export interface PrCommit {
  oid: string;
  messageHeadline: string;
  author: string;
  committedDate: string;
}

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: PrState;
  isDraft: boolean;
  url: string;
  author: string;
  authorIsBot: boolean;
  createdAt: string;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  /** Raw unified diff (`gh pr diff`); parse with parseUnifiedDiff in the UI. */
  diff: string;
  /** Conversation comments + reviews + inline review comments, chronological. */
  timeline: PrComment[];
  commits: PrCommit[];
  /** PR head commit SHA — the "new" side of every file diff. The "old" side is
   * reconstructed from `diff` (reverse-applied to the head blob), so no base SHA
   * is needed. null when the head ref couldn't be fetched (offline / no access). */
  headSha: string | null;
}

export interface PrDetailResult {
  ok: boolean;
  detail?: PrDetail;
  error?: string;
}

/** The PR head blob for one file (the "new" side). The "old" side is
 * reconstructed in the renderer by reverse-applying the diff. */
export interface PrFileView {
  text: string;
  binary: boolean;
}

/** A newer published release than the running app, per the GitHub feed. */
export interface UpdateInfo {
  /** Marketing version of the latest release, without the leading `v`. */
  version: string;
  /** GitHub Releases page to send the user to for the download. */
  url: string;
  /** Release notes (markdown); may be empty. */
  notes: string;
}

/** Scope of a CLAUDE.md / memory file in the Claude config viewer. */
export type ClaudeConfigScope = "global" | "project" | "memory";

/** One editable Claude instruction/memory file surfaced in the config modal. */
export interface ClaudeConfigFile {
  /** Absolute path on disk. */
  path: string;
  /** Friendly label (home dir tildified). */
  label: string;
  scope: ClaudeConfigScope;
  /** Current contents; "" when the file doesn't exist yet. */
  text: string;
  /** Whether the file currently exists on disk (false → editing creates it). */
  exists: boolean;
}

/**
 * The full set of files that shape Claude's behaviour for a project, resolved
 * for the config viewer: the global user file, the project CLAUDE.md cascade
 * (cwd up to root), and the per-project memory store.
 */
export interface ClaudeConfigBundle {
  global: ClaudeConfigFile;
  project: ClaudeConfigFile[];
  memory: ClaudeConfigFile[];
}

/**
 * Switcher trigger codes that MAIN forwards to the renderer as
 * "switcher:cycle" IPC (from before-input-event). Single source of truth for
 * both sides of the contract: main derives its forwarding rules from this
 * list (a Record keyed by SwitcherForwardedCode — adding a code here without
 * a rule is a compile error), and the renderer suppresses native-keydown
 * cycling for exactly these codes so main's forward is the ONLY cycle driver.
 * One keystroke must never step twice.
 */
export const SWITCHER_FORWARDED_CODES = ["Tab", "Backquote"] as const;
export type SwitcherForwardedCode = (typeof SWITCHER_FORWARDED_CODES)[number];
