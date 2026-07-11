import type { IPty } from "node-pty";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { agentProcessFor } from "./agent-probe";
import { defaultShell, shellEnv } from "./shell-env";
import { resolveWorkspaceCwd } from "./workspace";
import { classifyInputState, screenIsBusy } from "./tui-screen";
import type {
  TerminalActivity,
  TerminalChunk,
  TerminalInfo,
  TerminalInputState,
} from "../shared-types";

interface Session {
  pty: IPty;
  cwd: string;
  /** Output coalescing: TUIs emit many tiny chunks (spinners redraw constantly);
   *  batching to one IPC message per ~16ms keeps the renderer responsive. */
  pendingOut: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** A headless emulator fed the SAME pty bytes, kept current regardless of
   *  whether the renderer's xterm is visible — so we can read the rendered
   *  screen (the input box vs. an approval menu) even from the diffs tab. */
  screen: HeadlessTerminal;
  /** Trailing debounce for the activity evaluation after output. */
  evalTimer: ReturnType<typeof setTimeout> | null;
  /** Supersede marker: only the newest in-flight evaluation may emit. */
  evalGen: number;
  /** Last activity pushed to the renderer — emit only on change. */
  lastActivity: TerminalActivity;
}

/**
 * Persistent ptys keyed by an arbitrary terminal `id`. There may be several per
 * project: a default project terminal plus one "resume" terminal per chat
 * session the user has continued (see the renderer's id scheme).
 */
const sessions = new Map<string, Session>();
let onData: ((chunk: TerminalChunk) => void) | null = null;
let onExit: ((id: string) => void) | null = null;
let onActivity: ((id: string, activity: TerminalActivity) => void) | null =
  null;

export function setTerminalCallbacks(cbs: {
  onData: (chunk: TerminalChunk) => void;
  onExit: (id: string) => void;
  onActivity: (id: string, activity: TerminalActivity) => void;
}) {
  onData = cbs.onData;
  onExit = cbs.onExit;
  onActivity = cbs.onActivity;
}

// Lazy-loaded so a native-module load failure is caught and reported to the
// renderer rather than crashing the whole main process at import time.
let ptyModule: typeof import("node-pty") | null = null;
let ptyLoadError: string | null = null;
function loadPty(): typeof import("node-pty") | null {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require("node-pty") as typeof import("node-pty");
    return ptyModule;
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * Ensure a pty exists for terminal `id` (cwd resolved from `encoded`) and return
 * its cwd. Reuses the existing session if one is already running, so the shell +
 * any long-running process survive ⌘J toggles and project switches.
 *
 * `initialCommand`, if given, is run ONCE when the pty is first created (e.g.
 * `claude --resume <id>` for a chat-resume terminal). On reuse it's ignored.
 *
 * `subPath`, if given, resolves the cwd to that repo inside the project (used by
 * the Run/Build terminals in a multi-repo project, where each command targets
 * one of the project's git sub-repos).
 */
export async function openTerminal(
  id: string,
  encoded: string,
  cols = 80,
  rows = 24,
  initialCommand?: string,
  subPath = "",
): Promise<{ cwd: string; error?: string }> {
  const existing = sessions.get(id);
  if (existing) {
    try {
      existing.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
      existing.screen.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      /* resize on a dead pty */
    }
    return { cwd: existing.cwd };
  }

  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const mod = loadPty();
  if (!mod) {
    const msg = `\r\n\x1b[31mTerminal unavailable: failed to load node-pty.\x1b[0m\r\n${ptyLoadError ?? ""}\r\nTry: pnpm --filter @plan/desktop rebuild\r\n`;
    // Defer so the renderer has subscribed before we emit.
    setTimeout(() => onData?.({ id, data: msg }), 0);
    return { cwd, error: ptyLoadError ?? "node-pty failed to load" };
  }

  try {
    const pty = mod.spawn(defaultShell(), [], {
      name: "xterm-color",
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd,
      env: shellEnv(),
    });
    const screen = new HeadlessTerminal({
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      // No DOM here — writing to a headless emulator is cheap, so we feed it
      // every byte immediately (uncoalesced) to keep its grid frame-accurate.
      allowProposedApi: true,
      scrollback: 200,
    });
    const session: Session = {
      pty,
      cwd,
      pendingOut: "",
      flushTimer: null,
      screen,
      evalTimer: null,
      evalGen: 0,
      // A fresh shell is idle with no menu; only transitions are pushed.
      lastActivity: { busy: false, awaitingSelection: false },
    };
    pty.onData((data) => {
      session.screen.write(data);
      scheduleActivityEval(id, session);
      session.pendingOut += data;
      if (session.flushTimer) return;
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        const out = session.pendingOut;
        session.pendingOut = "";
        if (out) onData?.({ id, data: out });
      }, 16);
    });
    pty.onExit(() => {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      if (session.evalTimer) clearTimeout(session.evalTimer);
      if (session.pendingOut) onData?.({ id, data: session.pendingOut });
      try {
        session.screen.dispose();
      } catch {
        /* already disposed */
      }
      sessions.delete(id);
      onExit?.(id);
    });
    sessions.set(id, session);
    if (initialCommand) {
      // The shell buffers stdin until its prompt is ready, so a write right
      // after spawn is honoured — no timer needed.
      pty.write(`${initialCommand}\r`);
    }
    return { cwd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setTimeout(
      () =>
        onData?.({
          id,
          data: `\r\n\x1b[31mFailed to start shell: ${msg}\x1b[0m\r\n`,
        }),
      0,
    );
    return { cwd, error: msg };
  }
}

export function writeTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data);
}

/**
 * Live status of a terminal. `process` is the name of an agent process
 * (claude / node) found among the shell's descendants — see agent-probe.ts.
 * Falls back to node-pty's (less reliable) report if `ps` fails.
 */
export async function terminalStatus(
  id: string,
): Promise<{ running: boolean; process: string | null }> {
  const s = sessions.get(id);
  if (!s) return { running: false, process: null };
  try {
    return { running: true, process: await agentProcessFor(s.pty.pid) };
  } catch {
    let fallback: string | null = null;
    try {
      fallback = s.pty.process;
    } catch {
      /* dead pty */
    }
    return { running: true, process: fallback };
  }
}

/**
 * Send discrete keystrokes (e.g. arrow keys + Enter to drive a TUI selector),
 * spaced out so each is processed as its own keypress rather than a burst.
 */
export function sendKeys(id: string, keys: string[]) {
  if (!sessions.has(id)) return;
  keys.forEach((key, i) => {
    setTimeout(() => sessions.get(id)?.pty.write(key), i * 60);
  });
}

/**
 * Send a message to the program in terminal `id` and submit it: the body goes
 * out as one bracketed paste, then Enter (CR) follows as a SEPARATE keystroke
 * shortly after. Claude's TUI ignores an Enter bundled into the same input
 * batch as a paste (anti-accidental-submit), so the separation is required —
 * the same approach tmux-based Claude drivers use.
 */
export function submitToTerminal(
  id: string,
  text: string,
  imagePaths: string[] = [],
) {
  const s = sessions.get(id);
  if (!s) return;
  let body = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  // Image paths go on their OWN line after the text, inside the bracketed paste.
  // That's the shape Claude's TUI recognises as an attached image (recording it
  // as "[Image: source: <path>]", which the transcript renders) — typing the
  // path inline as plain text instead just leaves it as literal path text.
  if (imagePaths.length > 0) {
    body = [body, imagePaths.join(" ")].filter(Boolean).join("\n\n");
  }
  if (body) s.pty.write(`\x1b[200~${body}\x1b[201~`);
  // Enter follows as a SEPARATE keystroke (Claude ignores an Enter bundled into
  // the same batch as a paste). With an image, give Claude time to read + attach
  // the file first — an Enter arriving mid-attach is dropped, which left the
  // message sitting unsent in the input.
  setTimeout(
    () => {
      sessions.get(id)?.pty.write("\r");
    },
    imagePaths.length > 0 ? 650 : 150,
  );
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
    s.screen.resize(Math.max(cols, 1), Math.max(rows, 1));
  } catch {
    /* ignore */
  }
}

export function killTerminal(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.flushTimer) clearTimeout(s.flushTimer);
  try {
    s.pty.kill();
  } catch {
    // already gone
  }
  try {
    s.screen.dispose();
  } catch {
    /* already disposed */
  }
  sessions.delete(id);
}

/**
 * Kill a terminal and resolve only once its child process has actually exited
 * (or a timeout elapses). Needed before relocating a chat's transcript: a live
 * `claude` writes to a path derived from its cwd, so if it outlives the move it
 * re-creates a stub at the OLD path. Awaiting the real exit closes that race.
 */
export function killTerminalAndWait(
  id: string,
  timeoutMs = 4000,
): Promise<void> {
  const s = sessions.get(id);
  if (!s) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      s.pty.onExit(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
      return;
    }
    killTerminal(id);
  });
}

export function killAllTerminals() {
  for (const enc of [...sessions.keys()]) killTerminal(enc);
}

/** The visible screen of terminal `id` as plain text rows (trailing ws trimmed). */
function readScreen(id: string): string[] {
  const s = sessions.get(id);
  if (!s) return [];
  const buf = s.screen.buffer.active;
  const rows = s.screen.rows;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    out.push(line ? line.translateToString(true) : "");
  }
  return out;
}

/**
 * EXPERIMENTAL, heuristic. Classify the bottom of terminal `id`'s screen as a
 * free-text input box, a selection menu, or unknown (see tui-screen.ts for the
 * signatures). Returns the matched lines too, for debugging/validation.
 */
export function detectInputState(id: string): {
  state: TerminalInputState;
  lines: string[];
} {
  return classifyInputState(readScreen(id));
}

/** Whether terminal `id`'s rendered screen currently shows Claude's working
 *  hint ("esc to interrupt" in the footer — see tui-screen.ts). Reads the real
 *  rendered screen (a headless emulator fed the same bytes, kept current for
 *  every session incl. backgrounded ones), not an inference off a user action. */
export function isTerminalBusy(id: string): boolean {
  return screenIsBusy(readScreen(id));
}

// ── Event-driven activity ──────────────────────────────────────────
// The renderer used to poll busy/selection state on fixed intervals — a full
// screen scan of every pty several times a second, even at idle. Instead, a
// state change can only follow OUTPUT (the working hint appearing/disappearing
// and a menu being drawn/cleared are repaints), so each output burst schedules
// one trailing evaluation of THAT session, and only a changed result is pushed
// (terminal:activity). Idle sessions cost nothing.

// Trailing delay after an output burst. Output flows continuously while Claude
// works (spinner repaints re-arm the timer every 16ms flush... no — the timer
// is only set when none is pending, so a steady stream evaluates every 250ms),
// and the final repaint after the stream stops gets its own evaluation. Also
// comfortably after the headless emulator has parsed the burst.
const EVAL_DELAY_MS = 250;

function scheduleActivityEval(id: string, session: Session) {
  if (session.evalTimer) return;
  session.evalTimer = setTimeout(() => {
    session.evalTimer = null;
    void evaluateActivity(id, session);
  }, EVAL_DELAY_MS);
}

async function evaluateActivity(id: string, session: Session) {
  if (!sessions.has(id)) return; // exited while the timer was pending
  const gen = ++session.evalGen;
  const rows = readScreen(id);
  const busy = screenIsBusy(rows);
  let awaitingSelection = false;
  if (classifyInputState(rows).state === "selection") {
    // Gate on a live agent process (TTL-cached ps): a menu detected in a dead
    // shell's scrollback isn't actionable and must not raise the flag.
    try {
      const st = await terminalStatus(id);
      awaitingSelection = st.running && /claude|node/i.test(st.process ?? "");
    } catch {
      awaitingSelection = false;
    }
    // A newer evaluation started while we awaited ps — let it do the emitting.
    if (session.evalGen !== gen || !sessions.has(id)) return;
  }
  const prev = session.lastActivity;
  if (prev.busy === busy && prev.awaitingSelection === awaitingSelection)
    return;
  session.lastActivity = { busy, awaitingSelection };
  onActivity?.(id, session.lastActivity);
}

/** Ids of every live pty currently showing the "working" hint. */
export function busyTerminalIds(): string[] {
  const out: string[] = [];
  for (const id of sessions.keys()) {
    if (isTerminalBusy(id)) out.push(id);
  }
  return out;
}

/**
 * Ids of every live pty parked on a selection/approval menu with a live agent
 * process behind it — i.e. Claude is waiting on the user, not just showing
 * leftover menu text in a shell that has since dropped back to a prompt.
 *
 * This is the batched, cross-session form of the renderer's per-workspace
 * `awaitingSelection` check (`agentLive && state === "selection"`). Scanning
 * every session here — including backgrounded projects and worktrees — is what
 * lets the sidebar and notifier surface "needs approval" for sessions that
 * aren't the one on screen. The agent-liveness gate matters: a menu detected in
 * a dead shell (stale scrollback) isn't actionable and must not raise the flag.
 */
export async function awaitingSelectionIds(): Promise<string[]> {
  const candidates: string[] = [];
  for (const id of sessions.keys()) {
    if (detectInputState(id).state === "selection") candidates.push(id);
  }
  // No menu anywhere — skip the (cached, but not free) process-tree scan.
  if (candidates.length === 0) return [];
  const out: string[] = [];
  for (const id of candidates) {
    const st = await terminalStatus(id);
    // `terminalStatus` reports the agent among the pty's descendants (claude or
    // its node host); anything else means no live agent is driving the menu.
    if (st.running && /claude|node/i.test(st.process ?? "")) out.push(id);
  }
  return out;
}

/** Snapshot of every live pty — the source of truth for "what's running". */
export function listTerminals(): TerminalInfo[] {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    cwd: s.cwd,
    pid: s.pty.pid,
  }));
}
