/**
 * Chat engines — the plug point for "what actually drives a Claude session".
 *
 * A chat has always been two independent things in this app: the *transcript*
 * (`~/.claude/projects/<encoded>/<sessionId>.jsonl`, watched and parsed in main
 * — the single source of truth for everything rendered) and the *driver* (the
 * thing that starts Claude, feeds it your message, and reports whether it's
 * working or waiting on you). Only the driver is engine-specific. Headless
 * Claude writes the identical transcript an interactive TUI does, so swapping
 * the driver leaves message rendering, session lists, titles, notifications,
 * and badges untouched.
 *
 * This file is the shared vocabulary for that seam: engine ids, what each
 * engine can and can't do, and the facts an engine reports. Main implements it
 * (see main/agents/), the renderer consumes it, and — like ipc-contract.ts and
 * terminal-ids.ts — it has no Electron or Node imports so both programs can
 * include it.
 *
 * Chat ids are unchanged (`chat:<encoded>:<sessionId>`, see terminal-ids.ts).
 * Keeping them is deliberate: every downstream consumer — sidebar badges, the
 * approval notifier, the done notifier, the auto-continue watcher — is keyed on
 * that id and stays engine-agnostic for free.
 */

/**
 * What the bottom of a TUI-driven chat's screen looks like right now.
 * EXPERIMENTAL and heuristic — see main/providers/claude-code/tui-screen.ts,
 * which derives it. Named here because both programs report and read it.
 *
 *   "input"     — a free-text input box is present and ready (safe to type/send)
 *   "selection" — a numbered menu is up (tool approval / plan accept / question)
 *   "unknown"   — couldn't classify (plain shell, mid-render, clipped frame…)
 */
export type TerminalInputState = "input" | "selection" | "unknown";

/** Engines that can drive a chat. Registered in main/agents/engine-registry. */
export const CHAT_ENGINE_IDS = ["claude-cli"] as const;

export type ChatEngineId = (typeof CHAT_ENGINE_IDS)[number];

/** The engine used when nothing has been chosen — today's behaviour. */
export const DEFAULT_CHAT_ENGINE: ChatEngineId = "claude-cli";

export function isChatEngineId(value: unknown): value is ChatEngineId {
  return (
    typeof value === "string" &&
    (CHAT_ENGINE_IDS as readonly string[]).includes(value)
  );
}

/**
 * What an engine supports. The UI reads these instead of assuming — a surface
 * an engine can't back (a terminal pane it has no pty for, a TUI selector it
 * has no keystrokes for) must not be rendered at all rather than rendered dead.
 */
export interface ChatEngineCapabilities {
  /**
   * The chat is backed by a real pty the user can see and type into, so the
   * dock (⌘J) has something to show. False for engines that talk to Claude
   * over a protocol — there is no terminal, so there is no terminal pane.
   */
  terminalPane: boolean;
  /**
   * Menus are answered by writing raw keystrokes into a TUI. False for engines
   * whose approvals arrive as structured requests answered with data.
   */
  keystrokes: boolean;
  /**
   * `/branch` forks the session in place, and the live driver follows the fork
   * to its new session id (see the branch-follow path in project-workspace).
   */
  branch: boolean;
}

/** One registered engine as advertised to the renderer. */
export interface ChatEngineDescriptor {
  id: ChatEngineId;
  /** Short name for the settings picker. */
  label: string;
  /** One line on what it is and what you give up by choosing it. */
  description: string;
  capabilities: ChatEngineCapabilities;
}

/**
 * A chat's live activity, pushed on change (`chat:activity`).
 *
 * `busy` = a turn is in flight. `awaitingApproval` = Claude is parked waiting
 * for the user to approve or answer something. The two coexist: a session
 * sitting on an approval menu is still mid-turn.
 *
 * How each engine knows is its own business — the CLI engine reads Claude's
 * rendered screen, a protocol engine reads the protocol — but both report the
 * same two facts, and neither may report a state it hasn't observed.
 */
export interface ChatActivity {
  busy: boolean;
  awaitingApproval: boolean;
}

/** Whether a chat's driver is up, and whether Claude itself is live inside it. */
export interface ChatStatus {
  /** The driver exists (pty alive / session open). */
  running: boolean;
  /**
   * Claude itself is live and able to take a message. Distinct from `running`
   * because a driver can be up while the agent behind it is still booting or
   * has already exited — the composer waits on THIS, not on `running`.
   */
  agentLive: boolean;
  /** Which engine owns this chat, or null when nothing is driving it. */
  engine: ChatEngineId | null;
}

/** Everything an engine needs to start (or reattach to) one chat. */
export interface StartChatOptions {
  /** Claude-encoded cwd — the engine resolves the working directory from it. */
  encoded: string;
  sessionId: string;
  /**
   * True for a session this app minted an id for that has no transcript yet
   * (start it), false for one already on disk (resume it).
   */
  isNew: boolean;
  /** Run Claude with permissions on auto (the global Settings toggle). */
  autoMode: boolean;
  /** Engine to start with. Ignored when the chat is already being driven. */
  engine: ChatEngineId;
}

export interface StartChatResult {
  /** Resolved working directory of the chat. */
  cwd: string;
  /** The engine actually driving it — an already-live chat keeps its own. */
  engine: ChatEngineId;
  /** Set when the chat could not be started; nothing is driving it. */
  error?: string;
}
