import type { IPty } from "node-pty";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { execFile } from "child_process";
import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveProjectCwd } from "./claude-projects";

export interface TerminalChunk {
  id: string;
  data: string;
}

/**
 * What the bottom of the terminal screen looks like right now. EXPERIMENTAL and
 * heuristic — derived by scanning the rendered grid for Claude Code's TUI
 * signatures, not from any real protocol. Worded as a guess everywhere it's used.
 *
 *   "input"     — a free-text input box is present and ready (safe to type/send)
 *   "selection" — a numbered menu is up (tool approval / plan accept / question);
 *                 sending free text + Enter here would mis-navigate the menu
 *   "unknown"   — couldn't classify (plain shell, Claude mid-render, etc.)
 */
export type TerminalInputState = "input" | "selection" | "unknown";

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

/**
 * App-scoped zsh styling WITHOUT touching the user's dotfiles. We point zsh at
 * our own `ZDOTDIR`; each file there sources the user's real equivalent first
 * (so their PATH/aliases/plugins load unchanged), then our `.zshrc` layers the
 * terminal's prompt + colours on top. Only ptys spawned by this app get it;
 * every other terminal on the machine is unaffected. This is the same mechanism
 * VS Code uses for its shell integration.
 *
 * Returns the dir to use as `ZDOTDIR`, or null for non-zsh shells (where we
 * leave the environment completely alone).
 */
let cachedZdotdir: string | null | undefined;
function shellZdotdir(): string | null {
  if (cachedZdotdir !== undefined) return cachedZdotdir;
  cachedZdotdir = null;
  if (!/(^|\/)zsh$/.test(defaultShell())) return null;
  try {
    const dir = join(app.getPath("userData"), "shell", "zdotdir");
    mkdirSync(dir, { recursive: true });
    // Chain to the user's real startup files (ZDOTDIR stays ours, so zsh keeps
    // reading our files; each one pulls in the user's before we add anything).
    const chain = (name: string) =>
      `[[ -f "\${USER_ZDOTDIR:-$HOME}/${name}" ]] && source "\${USER_ZDOTDIR:-$HOME}/${name}"\n`;
    writeFileSync(join(dir, ".zshenv"), chain(".zshenv"));
    writeFileSync(join(dir, ".zprofile"), chain(".zprofile"));
    writeFileSync(join(dir, ".zlogin"), chain(".zlogin"));
    writeFileSync(
      join(dir, ".zshrc"),
      chain(".zshrc") +
        [
          "# Plan terminal styling — scoped to this app; your ~/.zshrc is untouched.",
          "export CLICOLOR=1",
          "export LSCOLORS=cxfxcxdxbxegedabagacad",
          // Full cwd (home shown as ~) in one soft tint, dim prompt symbol.
          "PROMPT='%F{108}%~%f %F{244}%#%f '",
          "",
        ].join("\n")
    );
    cachedZdotdir = dir;
  } catch {
    cachedZdotdir = null;
  }
  return cachedZdotdir;
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
      existing.screen.resize(Math.max(cols, 1), Math.max(rows, 1));
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
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
    };
    // Point zsh at our app-owned ZDOTDIR (which chains to the user's real
    // config) so the prompt/colours live in the app, not the user's dotfiles.
    const zdotdir = shellZdotdir();
    if (zdotdir) {
      // Point at the user's REAL config dir. If we were launched from inside one
      // of our own terminals, the inherited ZDOTDIR is already ours — using it
      // would make our .zshrc source itself forever, so fall back to the real
      // dir the parent stashed in USER_ZDOTDIR (then $HOME).
      const inherited = process.env.ZDOTDIR;
      const realUserDir =
        inherited && inherited !== zdotdir ? inherited : process.env.USER_ZDOTDIR;
      env.USER_ZDOTDIR = realUserDir || process.env.HOME || "";
      env.ZDOTDIR = zdotdir;
    }
    const pty = mod.spawn(defaultShell(), [], {
      name: "xterm-color",
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd,
      env,
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
    };
    pty.onData((data) => {
      session.screen.write(data);
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
// `ps -ax` lists EVERY process on the system and is the expensive part of a
// status check (100–500ms on a busy Mac). The output is identical for every
// terminal at a given moment, yet each open session polls status independently
// (1–5s each). So we snapshot the whole process tree once and share it for a
// short window: concurrent and back-to-back polls collapse onto one `ps` run
// instead of spawning one each. The per-terminal BFS below is then in-memory.
type ProcTree = Map<number, { pid: number; comm: string }[]>;
const PS_TTL_MS = 2_000;
let procTreeCache: { at: number; tree: ProcTree } | null = null;
let procTreeInflight: Promise<ProcTree> | null = null;

function getProcessTree(): Promise<ProcTree> {
  const now = Date.now();
  if (procTreeCache && now - procTreeCache.at < PS_TTL_MS) {
    return Promise.resolve(procTreeCache.tree);
  }
  if (procTreeInflight) return procTreeInflight;
  procTreeInflight = new Promise<ProcTree>((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid=,comm="], (err, stdout) => {
      procTreeInflight = null;
      if (err) {
        reject(err);
        return;
      }
      const childrenOf: ProcTree = new Map();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const entry = { pid: Number(m[1]), comm: m[3] };
        const ppid = Number(m[2]);
        const arr = childrenOf.get(ppid);
        if (arr) arr.push(entry);
        else childrenOf.set(ppid, [entry]);
      }
      procTreeCache = { at: Date.now(), tree: childrenOf };
      resolve(childrenOf);
    });
  });
  return procTreeInflight;
}

export async function terminalStatus(
  id: string
): Promise<{ running: boolean; process: string | null }> {
  const s = sessions.get(id);
  if (!s) return { running: false, process: null };
  let childrenOf: ProcTree;
  try {
    childrenOf = await getProcessTree();
  } catch {
    // `ps` failed — fall back to node-pty's (less reliable) report.
    let fallback: string | null = null;
    try {
      fallback = s.pty.process;
    } catch {
      /* dead pty */
    }
    return { running: true, process: fallback };
  }
  // BFS from the pty's shell pid for an agent process among its descendants.
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
  return { running: true, process: found };
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
  imagePaths: string[] = []
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
    imagePaths.length > 0 ? 650 : 150
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

// Claude Code blocks for input in two visually different shapes:
//
//  1. Yes/No-style menus (tool approval, plan accept): a NUMBERED option with a
//     ❯ pointer on the highlighted one, e.g. "❯ 1. Yes". A bare chevron is NOT
//     enough — the composer's own prompt is also "❯" (or "> ") in current
//     builds, so only "❯ <number>." means a menu (matching a bare chevron, as
//     an earlier version did, misread the normal composer as a menu).
//
//  2. AskUserQuestion pickers: options are highlighted by COLOR, not a ❯, so
//     shape (1) misses them entirely. What they reliably carry is a footer hint
//     line — "Enter to select", "Tab to switch questions", "Esc to cancel".
//     "Esc to cancel" also rides on the Yes/No prompts, so it doubles as a
//     general "an interactive prompt is up" signal. It is distinct from the
//     working spinner's "(esc to interrupt)" — different word, so no clash.
//
// All heuristics on rendered glyphs, not a protocol — word any UI as a guess.
const SELECTION_RE =
  /❯\s*\d+[.)]|Esc to cancel|Enter to select|Tab to switch questions/;
const INPUT_BOX_RE = /[│|]\s*[>❯]\s/;

/**
 * EXPERIMENTAL, heuristic. Classify the bottom of terminal `id`'s screen as a
 * free-text input box, a selection menu, or unknown. Returns the matched lines
 * too, so the renderer can surface them for debugging/validation.
 */
export function detectInputState(
  id: string
): { state: TerminalInputState; lines: string[] } {
  const all = readScreen(id);
  // Only the bottom chunk matters (the box sits at the foot of the frame), and
  // ignoring the top avoids matching menu-like text in scrollback history.
  const tail = all.slice(-16);
  const nonEmpty = tail.filter((l) => l.trim().length > 0);
  const text = nonEmpty.join("\n");
  let state: TerminalInputState = "unknown";
  if (SELECTION_RE.test(text)) state = "selection";
  else if (INPUT_BOX_RE.test(text)) state = "input";
  return { state, lines: nonEmpty.slice(-12) };
}

/**
 * Full rendered text of terminal `id` (scrollback + visible screen), trimmed of
 * leading/trailing blank lines. Debug aid: lets the UI copy what the headless
 * emulator currently "sees" so the detection heuristics can be tuned against
 * real Claude Code frames.
 */
export function dumpTerminal(id: string): string {
  const s = sessions.get(id);
  if (!s) return "";
  const buf = s.screen.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : "");
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

// While a Claude turn is in flight, its TUI footer renders an "esc to interrupt"
// hint, and drops it the instant the turn ends (returning to the idle prompt or
// stopping at an approval menu). That hint is the one true "working" signal:
//
//   - Unlike output timing, a scroll repaint can't fake it. Claude runs with
//     mouse tracking on, so scrolling sends wheel escapes to the pty and Claude
//     repaints — a real output stream that fooled the old timing-based signal
//     into "working" for as long as you scrolled. Scrolling never renders this
//     hint, so reading it instead is immune (verified against real frames).
//   - Unlike the "✻ Worked for 2s" summaries (which linger in scrollback), it's
//     only ever present live, so it never produces a stale match.
//
// The hint lives in the FOOTER — the live region BELOW the input box. Everything
// ABOVE the input box is transcript, which can legitimately contain the words
// "esc to interrupt" (e.g. a chat discussing this very feature — which once
// pinned a session to "working" forever), so we never scan there. The footer is
// NOT always the last row or two, though: while Claude runs sub-agents it draws
// an agent-management panel ("← for agents · ↓ to manage", then a list of
// agents) BELOW the hint, so a fixed "last N rows" window slid right past it and
// the status fell back to idle. Anchoring to the input box instead covers the
// whole footer no matter how tall that panel grows. Reads the real rendered
// screen (a headless emulator fed the same bytes, kept current for every session
// incl. backgrounded ones), not an inference off a user action.
const WORKING_HINT_RE = /esc to interrupt/i;
// The input-prompt line — the boundary between transcript (above) and the live
// footer (below). Matches the bordered box ("│ > ", "│ ❯ ") and the borderless
// prompt ("› ", "❯ ", "> "). We take the LOWEST match: the real input box is
// always the bottom-most prompt-looking line (a markdown blockquote "> " in the
// transcript only ever sits above it, and scanning from there down still lands
// on the same footer).
const PROMPT_LINE_RE = /^\s*(?:[│|]\s*)?[>❯›](?:\s|$)/;
// Fallback footer window when no input prompt can be found (unexpected frame).
const FOOTER_ROWS = 3;

/** Whether terminal `id`'s rendered screen currently shows Claude's working hint. */
export function isTerminalBusy(id: string): boolean {
  const rows = readScreen(id);
  let boundary = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PROMPT_LINE_RE.test(rows[i])) {
      boundary = i;
      break;
    }
  }
  const region =
    boundary >= 0
      ? rows.slice(boundary + 1)
      : rows.filter((line) => line.trim().length > 0).slice(-FOOTER_ROWS);
  return region.some((line) => WORKING_HINT_RE.test(line));
}

/** Ids of every live pty currently showing the "working" hint. */
export function busyTerminalIds(): string[] {
  const out: string[] = [];
  for (const id of sessions.keys()) {
    if (isTerminalBusy(id)) out.push(id);
  }
  return out;
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
