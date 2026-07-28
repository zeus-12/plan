import type { IPty } from "node-pty";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { defaultShell, shellEnv } from "./shell-env";
import { resolveWorkspaceCwd } from "./workspace";
import type { TerminalChunk, TerminalInfo } from "../shared-types";

interface Session {
  /** The pty's CURRENT terminal id — the key it's stored under in `sessions`.
   *  Lives on the session (not just captured in closures) so a rekey can
   *  re-tag the id every emit path reports under (data/exit/activity). */
  id: string;
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
}

/**
 * Persistent ptys keyed by an arbitrary terminal `id`. There may be several per
 * project: a default project terminal plus one "resume" terminal per chat
 * session the user has continued (see the renderer's id scheme).
 */
const sessions = new Map<string, Session>();

export interface TerminalListener {
  onData?: (chunk: TerminalChunk) => void;
  onExit?: (id: string) => void;
}

/**
 * Several parts of main watch the same ptys: the renderer bridge forwards every
 * event over IPC, and the CLI chat engine translates the chat ptys' events into
 * engine-level ones. A list (rather than one settable callback) is what lets
 * both attach without either owning the channel.
 */
const listeners = new Set<TerminalListener>();

export function addTerminalListener(l: TerminalListener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function emitData(chunk: TerminalChunk) {
  for (const l of listeners) l.onData?.(chunk);
}
function emitExit(id: string) {
  for (const l of listeners) l.onExit?.(id);
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
 * `claude --resume <id>` for a chat terminal). On reuse it's ignored.
 *
 * `cols`/`rows` size the pty. Omit them when the caller has no view to size it
 * to — starting a chat's Claude before any pane is mounted, say. A fresh pty
 * then gets the conventional 80×24 (what the pane's xterm reports before its
 * first fit anyway), and an EXISTING one is left at whatever size its pane
 * already fitted it to rather than being squeezed back down.
 *
 * `attachOnly` binds to a running pty and refuses to create one. Chat ptys are
 * owned by their engine, so a chat's PANE must attach and never spawn: a pane
 * that spawned its own would get a bare shell with no Claude in it, and — worse
 * — the engine would then see a live pty under that id, conclude the chat was
 * already being driven, and reattach to the empty shell forever.
 *
 * `subPath`, if given, resolves the cwd to that repo inside the project (used by
 * the Run/Build terminals in a multi-repo project, where each command targets
 * one of the project's git sub-repos).
 */
export async function openTerminal(
  id: string,
  encoded: string,
  cols?: number,
  rows?: number,
  initialCommand?: string,
  subPath = "",
  opts: { attachOnly?: boolean } = {},
): Promise<{ cwd: string; error?: string }> {
  const existing = sessions.get(id);
  if (existing) {
    if (cols != null && rows != null) {
      try {
        existing.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
        existing.screen.resize(Math.max(cols, 1), Math.max(rows, 1));
      } catch {
        /* resize on a dead pty */
      }
    }
    return { cwd: existing.cwd };
  }
  if (opts.attachOnly) {
    return {
      cwd: await resolveWorkspaceCwd(encoded, subPath),
      error: `No terminal is running for ${id}.`,
    };
  }
  const spawnCols = Math.max(cols ?? 80, 1);
  const spawnRows = Math.max(rows ?? 24, 1);

  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  const mod = loadPty();
  if (!mod) {
    const msg = `\r\n\x1b[31mTerminal unavailable: failed to load node-pty.\x1b[0m\r\n${ptyLoadError ?? ""}\r\nTry: pnpm --filter @plan/desktop rebuild\r\n`;
    // Defer so the renderer has subscribed before we emit.
    setTimeout(() => emitData({ id, data: msg }), 0);
    return { cwd, error: ptyLoadError ?? "node-pty failed to load" };
  }

  try {
    const pty = mod.spawn(defaultShell(), [], {
      name: "xterm-color",
      cols: spawnCols,
      rows: spawnRows,
      cwd,
      env: shellEnv(),
    });
    const screen = new HeadlessTerminal({
      cols: spawnCols,
      rows: spawnRows,
      // No DOM here — writing to a headless emulator is cheap, so we feed it
      // every byte immediately (uncoalesced) to keep its grid frame-accurate.
      allowProposedApi: true,
      scrollback: 200,
    });
    const session: Session = {
      id,
      pty,
      cwd,
      pendingOut: "",
      flushTimer: null,
      screen,
    };
    pty.onData((data) => {
      session.screen.write(data);
      session.pendingOut += data;
      if (session.flushTimer) return;
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        const out = session.pendingOut;
        session.pendingOut = "";
        if (out) emitData({ id: session.id, data: out });
      }, 16);
    });
    pty.onExit(() => {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      if (session.pendingOut)
        emitData({ id: session.id, data: session.pendingOut });
      try {
        session.screen.dispose();
      } catch {
        /* already disposed */
      }
      sessions.delete(session.id);
      emitExit(session.id);
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
        emitData({
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

/** Whether a pty is alive under this id. */
export function isTerminalRunning(id: string): boolean {
  return sessions.has(id);
}

/** A live pty's process id, for callers that need to inspect its descendants. */
export function terminalPid(id: string): number | null {
  return sessions.get(id)?.pty.pid ?? null;
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

/** The visible screen of terminal `id` as plain text rows (trailing ws trimmed).
 *  Read off a headless emulator fed the same bytes as the renderer's xterm and
 *  kept current whether or not a pane is mounted, so a backgrounded pty's screen
 *  is as readable as the one on screen. What the rows MEAN is the caller's
 *  business — see the Claude provider for the TUI it knows how to read. */
export function terminalScreen(id: string): string[] {
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

/** Every live pty id. */
export function terminalIds(): string[] {
  return [...sessions.keys()];
}

/**
 * Re-key a live pty from `oldId` to `newId` in place — same process, same
 * headless screen, same pending output. Used when a chat's `claude` migrates to
 * a different session id (a `/branch` fork writes a new transcript from the same
 * process): the pty registered as the old session is really driving the new one,
 * so we rename it rather than leave it addressable under a session it left.
 *
 * Returns false when there's nothing to move (no pty under `oldId`) or the
 * destination is taken (`newId` already live) — the caller must not proceed to
 * repoint the UI in either case.
 */
export function rekeyTerminal(oldId: string, newId: string): boolean {
  if (oldId === newId) return false;
  const s = sessions.get(oldId);
  if (!s || sessions.has(newId)) return false;
  sessions.delete(oldId);
  s.id = newId;
  sessions.set(newId, s);
  return true;
}

/** Snapshot of every live pty — the source of truth for "what's running". */
export function listTerminals(): TerminalInfo[] {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    cwd: s.cwd,
    pid: s.pty.pid,
  }));
}
