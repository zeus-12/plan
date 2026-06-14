import type { IPty } from "node-pty";
import { execFile } from "child_process";
import { resolveProjectCwd } from "./claude-projects";

export interface TerminalChunk {
  id: string;
  data: string;
}

interface Session {
  pty: IPty;
  cwd: string;
  /** Output coalescing: TUIs emit many tiny chunks (spinners redraw constantly);
   *  batching to one IPC message per ~16ms keeps the renderer responsive. */
  pendingOut: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Persistent ptys keyed by an arbitrary terminal `id`. There may be several per
 * project: a default project terminal plus one "resume" terminal per chat
 * session the user has continued (see the renderer's id scheme).
 */
const sessions = new Map<string, Session>();
let onData: ((chunk: TerminalChunk) => void) | null = null;
let onExit: ((id: string) => void) | null = null;

export function setTerminalCallbacks(cbs: {
  onData: (chunk: TerminalChunk) => void;
  onExit: (id: string) => void;
}) {
  onData = cbs.onData;
  onExit = cbs.onExit;
}

function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
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
 */
export async function openTerminal(
  id: string,
  encoded: string,
  cols = 80,
  rows = 24,
  initialCommand?: string
): Promise<{ cwd: string; error?: string }> {
  const existing = sessions.get(id);
  if (existing) {
    try {
      existing.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
    } catch {
      /* resize on a dead pty */
    }
    return { cwd: existing.cwd };
  }

  const cwd = await resolveProjectCwd(encoded);
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
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const session: Session = { pty, cwd, pendingOut: "", flushTimer: null };
    pty.onData((data) => {
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
      if (session.pendingOut) onData?.({ id, data: session.pendingOut });
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
      () => onData?.({ id, data: `\r\n\x1b[31mFailed to start shell: ${msg}\x1b[0m\r\n` }),
      0
    );
    return { cwd, error: msg };
  }
}

export function writeTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data);
}

/**
 * Live status of a terminal. `process` is the name of an agent process
 * (claude / node) found among the shell's descendants — determined by walking
 * the real process tree (`ps`), since node-pty's foreground-process name is
 * unreliable on macOS. Falls back to node-pty's report if `ps` fails.
 */
export function terminalStatus(
  id: string
): Promise<{ running: boolean; process: string | null }> {
  const s = sessions.get(id);
  if (!s) return Promise.resolve({ running: false, process: null });
  return new Promise((resolve) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid=,comm="], (err, stdout) => {
      if (err) {
        let fallback: string | null = null;
        try {
          fallback = s.pty.process;
        } catch {
          /* dead pty */
        }
        resolve({ running: true, process: fallback });
        return;
      }
      // Build ppid → children, then BFS from the pty's shell pid.
      const childrenOf = new Map<number, { pid: number; comm: string }[]>();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const entry = { pid: Number(m[1]), comm: m[3] };
        const ppid = Number(m[2]);
        const arr = childrenOf.get(ppid);
        if (arr) arr.push(entry);
        else childrenOf.set(ppid, [entry]);
      }
      let found: string | null = null;
      const queue = [s.pty.pid];
      while (queue.length > 0 && !found) {
        const pid = queue.shift()!;
        for (const c of childrenOf.get(pid) ?? []) {
          const base = (c.comm.split("/").pop() ?? c.comm).toLowerCase();
          if (base.includes("claude") || base === "node") {
            found = base;
            break;
          }
          queue.push(c.pid);
        }
      }
      resolve({ running: true, process: found });
    });
  });
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
export function submitToTerminal(id: string, text: string) {
  const s = sessions.get(id);
  if (!s) return;
  const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  s.pty.write(`\x1b[200~${body}\x1b[201~`);
  setTimeout(() => {
    sessions.get(id)?.pty.write("\r");
  }, 150);
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  try {
    sessions.get(id)?.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
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
  sessions.delete(id);
}

export function killAllTerminals() {
  for (const enc of [...sessions.keys()]) killTerminal(enc);
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  pid: number;
}

/** Snapshot of every live pty — the source of truth for "what's running". */
export function listTerminals(): TerminalInfo[] {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    cwd: s.cwd,
    pid: s.pty.pid,
  }));
}
