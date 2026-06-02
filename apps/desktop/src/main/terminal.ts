import type { IPty } from "node-pty";
import { resolveProjectCwd } from "./claude-projects";

export interface TerminalChunk {
  encoded: string;
  data: string;
}

interface Session {
  pty: IPty;
  cwd: string;
}

/** One persistent pty per project (keyed by encoded dir name). */
const sessions = new Map<string, Session>();
let onData: ((chunk: TerminalChunk) => void) | null = null;
let onExit: ((encoded: string) => void) | null = null;

export function setTerminalCallbacks(cbs: {
  onData: (chunk: TerminalChunk) => void;
  onExit: (encoded: string) => void;
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
 * Ensure a pty exists for the project and return its cwd. Reuses the existing
 * session if one is already running (so the shell + any long-running process
 * survive ⌘J toggles and project switches).
 */
export async function openTerminal(
  encoded: string,
  cols = 80,
  rows = 24
): Promise<{ cwd: string; error?: string }> {
  const existing = sessions.get(encoded);
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
    setTimeout(() => onData?.({ encoded, data: msg }), 0);
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
    pty.onData((data) => onData?.({ encoded, data }));
    pty.onExit(() => {
      sessions.delete(encoded);
      onExit?.(encoded);
    });
    sessions.set(encoded, { pty, cwd });
    return { cwd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setTimeout(
      () => onData?.({ encoded, data: `\r\n\x1b[31mFailed to start shell: ${msg}\x1b[0m\r\n` }),
      0
    );
    return { cwd, error: msg };
  }
}

export function writeTerminal(encoded: string, data: string) {
  sessions.get(encoded)?.pty.write(data);
}

export function resizeTerminal(encoded: string, cols: number, rows: number) {
  try {
    sessions.get(encoded)?.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
  } catch {
    /* ignore */
  }
}

export function killTerminal(encoded: string) {
  const s = sessions.get(encoded);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    // already gone
  }
  sessions.delete(encoded);
}

export function killAllTerminals() {
  for (const enc of [...sessions.keys()]) killTerminal(enc);
}
