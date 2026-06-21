import { useEffect, useRef, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import { TerminalPanel } from "./terminal-panel";

interface Props {
  /** Pty id — `run:<encoded>`, scoped to this worktree so its process is its own. */
  id: string;
  /** Worktree encoded dir — main resolves the pty cwd from it. */
  encoded: string;
  /** Project-level run command (shared across worktrees). Undefined = unset. */
  runCommand?: string;
  /** Optional build command, run before `runCommand` in the same terminal. */
  buildCommand?: string;
  /** Whether the pane is shown (drives the embedded terminal's refit/focus). */
  visible: boolean;
  /** Open the Run-command config modal. */
  onConfigure: () => void;
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

const headerBtnCls =
  "flex h-5 items-center gap-1 rounded px-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]";

/**
 * The always-present "Run" terminal. The command is project-level (passed in,
 * shared across worktrees); the running process is per-worktree (pty `id` keyed
 * by this worktree's encoded). We never assume the process is alive — the view
 * is driven by the real pty: `terminalStatus` on mount/worktree-switch, and the
 * `terminal:exit` event when it stops.
 */
export function RunTerminal({
  id,
  encoded,
  runCommand,
  buildCommand,
  visible,
  onConfigure,
}: Props) {
  // null = still probing main; true/false once the real pty state is known.
  const [running, setRunning] = useState<boolean | null>(null);
  // When set, the next exit (from our own kill) is immediately followed by a
  // fresh start — that's "Restart".
  const pendingRestart = useRef(false);

  const cmd = runCommand?.trim() ?? "";
  const build = buildCommand?.trim() ?? "";
  const hasCommand = cmd !== "";
  const initialCommand = build ? `${build} && ${cmd}` : cmd;

  // On mount and whenever the worktree (id) changes, ask main whether this
  // worktree's Run pty is already alive and reattach if so — otherwise we show
  // the Run button. The probe is the source of truth, not an assumption.
  useEffect(() => {
    let cancelled = false;
    setRunning(null);
    window.electronAPI.terminalStatus(id).then((s) => {
      if (!cancelled) setRunning(s.running);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The process ending (exit / crash / our own kill) drops us back to the Run
  // button — truthful, because it really stopped. A pending restart re-mounts a
  // fresh pty (the session is already gone in main by the time exit fires).
  useEffect(
    () =>
      window.electronAPI.onTerminalExit((exited) => {
        if (exited !== id) return;
        setRunning(false);
        if (pendingRestart.current) {
          pendingRestart.current = false;
          requestAnimationFrame(() => setRunning(true));
        }
      }),
    [id]
  );

  const start = () => {
    if (!hasCommand) return;
    // Mounting TerminalPanel calls terminalOpen(id, …, initialCommand), which
    // spawns the pty and runs the command. Its promise resolving is the local
    // guarantee the pty exists, so flipping to the attached view isn't a guess.
    setRunning(true);
  };

  const restart = () => {
    pendingRestart.current = true;
    window.electronAPI.terminalKill(id);
  };

  // Probing — render nothing rather than flash the wrong state.
  if (running === null) {
    return <div className="h-full w-full bg-[var(--bg)]" />;
  }

  if (running) {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--bg)]">
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-[var(--border)] px-2 py-1">
          <button className={headerBtnCls} onClick={restart} title="Restart">
            <RestartIcon />
            Restart
          </button>
          <button
            className={headerBtnCls}
            onClick={onConfigure}
            title="Edit run command"
          >
            <GearIcon />
            Configure
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalPanel
            id={id}
            encoded={encoded}
            showHeader={false}
            initialCommand={initialCommand}
            visible={visible}
          />
        </div>
      </div>
    );
  }

  // Idle: centered Run button (or Configure prompt when no command is set yet).
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--bg)] px-6 text-center">
      <button
        onClick={start}
        disabled={!hasCommand}
        title={hasCommand ? `Run: ${initialCommand}` : "Set a run command first"}
        className={cn(
          "flex items-center gap-2 rounded-md px-4 py-2 font-[family-name:var(--font-mono)] text-[13px] font-medium transition-colors",
          hasCommand
            ? "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
            : "cursor-not-allowed border border-[var(--border)] text-[var(--text-tertiary)]"
        )}
      >
        <PlayIcon />
        Run
      </button>
      {hasCommand ? (
        <button
          onClick={onConfigure}
          className="flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
        >
          <GearIcon />
          {initialCommand}
        </button>
      ) : (
        <button
          onClick={onConfigure}
          className="flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
        >
          <GearIcon />
          Configure run command
        </button>
      )}
    </div>
  );
}
