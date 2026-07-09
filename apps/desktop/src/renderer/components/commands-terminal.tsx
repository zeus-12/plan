import { useEffect, useRef, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import type { CommandEntry, DiscoveredRepo } from "../../shared-types";
import { commandTerminalId } from "../../terminal-ids";
import { TerminalPanel } from "./terminal-panel";
import { entryLabel } from "../lib/commands";

interface Props {
  /** "run" → pty `run:<encoded>:<id>`; "build" → `build:<encoded>:<id>`. */
  kind: "run" | "build";
  /** Worktree encoded dir — main resolves each pty's cwd from it (+ entry.subPath). */
  encoded: string;
  /** Project-level command list (shared across worktrees). Empty = unconfigured. */
  entries: CommandEntry[];
  /** Sub-repos of the project — used to label repo-bound entries' sub-tabs. */
  repos: DiscoveredRepo[];
  /** Whether the pane is shown (drives the embedded terminals' refit/focus). */
  visible: boolean;
  /** Changing this forces a refit (e.g. after the sidebar's open animation). */
  fitSignal?: number;
  /** Open this tab's command-config modal. */
  onConfigure: () => void;
}

function PlayIcon() {
  return (
    <svg width="8" height="10" viewBox="0 0 9 11" fill="currentColor">
      <path d="M0 0l9 5.5L0 11z" />
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

// Small glyphs shown in a sub-tab's status slot on hover (restart when running,
// play when idle) — the per-command re-run affordance.
function MiniRestartIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function MiniPlayIcon() {
  return (
    <svg width="8" height="9" viewBox="0 0 9 11" fill="currentColor">
      <path d="M0 0l9 5.5L0 11z" />
    </svg>
  );
}

// The one prominent action in the header — a proper filled button, not a ghost.
const runBtnCls =
  "flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-[var(--text)] px-2.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90";
// Secondary "edit commands" gear. Always visible (it was opacity-0 until header
// hover, which made it nearly impossible to find) but styled as a quiet,
// bordered control so it reads as a button without competing with Run.
const gearBtnCls =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]";

/**
 * The Run / Build terminal. Its command list is project-level (passed in, shared
 * across worktrees); each entry runs in its own per-worktree pty (keyed by this
 * worktree's `encoded` + the entry id). When there's more than one entry we show
 * a sub-tab per entry so you can watch each one's output; "Run all" starts them
 * together. We never assume a process is alive — each view is driven by the real
 * pty: `terminalStatus` on mount/worktree-switch, and `terminal:exit` when it stops.
 */
export function CommandsTerminal({
  kind,
  encoded,
  entries,
  repos,
  visible,
  fitSignal,
  onConfigure,
}: Props) {
  const label = kind === "build" ? "Build" : "Run";
  // Stable key for the effects: re-probe / re-subscribe only when the entry set
  // itself changes (its identity churns every parent render).
  const entryKey = entries.map((e) => e.id).join(",");
  const ptyId = (e: CommandEntry) => commandTerminalId(kind, encoded, e.id);

  // Which entries are mounted (pty spawned / spawning). Truth-driven: seeded by a
  // status probe, updated by our own start/stop and by real `terminal:exit`.
  const [started, setStarted] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState<string | null>(entries[0]?.id ?? null);
  const [probed, setProbed] = useState(false);
  // Entry ids whose next exit (from our own kill) is immediately followed by a
  // fresh start — that's a per-tab "Restart".
  const pendingRestart = useRef<Set<string>>(new Set());

  // Keep the active sub-tab pointing at a still-present entry.
  useEffect(() => {
    if (entries.length === 0) {
      setActive(null);
      return;
    }
    setActive((cur) =>
      cur && entries.some((e) => e.id === cur) ? cur : entries[0].id,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  // On mount and whenever the worktree (encoded) or entry set changes, ask main
  // which of this tab's ptys are already alive and reattach — the probe is the
  // source of truth, not an assumption.
  useEffect(() => {
    let cancelled = false;
    setProbed(false);
    Promise.all(
      entries.map(async (e) => {
        const s = await window.electronAPI.terminalStatus(ptyId(e));
        return [e.id, s.running] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const [id, running] of pairs) if (running) next[id] = true;
      setStarted(next);
      setProbed(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, entryKey, kind]);

  // A process ending (exit / crash / our own kill) drops its tab back to idle —
  // truthful, because it really stopped. A pending restart re-mounts a fresh pty.
  useEffect(
    () =>
      window.electronAPI.onTerminalExit((exited) => {
        const entry = entries.find((e) => ptyId(e) === exited);
        if (!entry) return;
        // Drop the tab to idle first (unmounts its TerminalPanel). A pending
        // restart then re-mounts a fresh panel next frame — the remount is what
        // re-runs the command (mounting calls terminalOpen with initialCommand);
        // keeping it mounted would leave a dead pane with nothing re-run.
        setStarted((s) => {
          const next = { ...s };
          delete next[entry.id];
          return next;
        });
        if (pendingRestart.current.has(entry.id)) {
          pendingRestart.current.delete(entry.id);
          requestAnimationFrame(() =>
            setStarted((s) => ({ ...s, [entry.id]: true })),
          );
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entryKey, encoded, kind],
  );

  const startEntry = (id: string) => setStarted((s) => ({ ...s, [id]: true }));
  // The single header action: (re)run every command. Idle entries start; already-
  // running ones restart (kill → the exit handler re-mounts a fresh pty). This is
  // the sole start/restart control now — there's no separate Restart button.
  // (Re)run just one command, leaving the others alone: idle → start, running →
  // restart (kill; the exit handler re-mounts a fresh pty).
  const runEntry = (e: CommandEntry) => {
    if (!e.command.trim()) return;
    if (started[e.id]) {
      pendingRestart.current.add(e.id);
      window.electronAPI.terminalKill(ptyId(e));
    } else {
      startEntry(e.id);
    }
  };
  // The header action: (re)run every command at once.
  const runAll = () => {
    for (const e of entries) runEntry(e);
  };

  // Nothing configured yet — invite the user to set commands.
  if (entries.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--bg)] px-6 text-center">
        <button
          onClick={onConfigure}
          className="flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
        >
          <GearIcon />
          Configure {label.toLowerCase()} command
        </button>
      </div>
    );
  }

  // Probing — render nothing rather than flash the wrong state.
  if (!probed) {
    return <div className="h-full w-full bg-[var(--bg)]" />;
  }

  const multi = entries.length > 1;
  const activeEntry = entries.find((e) => e.id === active) ?? entries[0];
  const anyStarted = entries.some((e) => started[e.id]);
  const showHeader = multi || anyStarted;
  const runLabel = multi ? `${label} all` : label;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)]">
      {showHeader && (
        <div className="group flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2.5 py-2">
          {multi && (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {entries.map((e, i) => {
                const on = e.id === active;
                return (
                  <button
                    key={e.id}
                    onClick={() => setActive(e.id)}
                    title={e.command}
                    className={cn(
                      "group/tab flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 font-[family-name:var(--font-mono)] text-[12px] transition-colors",
                      on
                        ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
                        : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                    )}
                  >
                    {/* Status dot by default; on hover it becomes a click target
                        that (re)runs just this command without touching the rest.
                        The action span only takes clicks while shown (hover), so a
                        normal click on the dot still selects the tab. */}
                    <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full transition-opacity group-hover/tab:opacity-0",
                          started[e.id]
                            ? "bg-[var(--accent,#4ade80)]"
                            : "bg-[var(--border-strong)]",
                        )}
                      />
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          runEntry(e);
                        }}
                        title={`${started[e.id] ? "Restart" : "Run"} ${entryLabel(e, repos, `${label} ${i + 1}`)}`}
                        className="absolute inset-0 hidden items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--text)] group-hover/tab:flex"
                      >
                        {started[e.id] ? <MiniRestartIcon /> : <MiniPlayIcon />}
                      </span>
                    </span>
                    <span className="max-w-[140px] truncate">
                      {entryLabel(e, repos, `${label} ${i + 1}`)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className={cn("flex items-center gap-1.5", !multi && "ml-auto")}>
            <button
              className={runBtnCls}
              onClick={runAll}
              title={multi ? "Run every command" : `Run ${activeEntry.command}`}
            >
              <PlayIcon />
              {runLabel}
            </button>
            {/* Edit commands — a quiet but always-visible control beside Run. */}
            <button
              className={gearBtnCls}
              onClick={onConfigure}
              title={`Edit ${label.toLowerCase()} commands`}
              aria-label={`Edit ${label.toLowerCase()} commands`}
            >
              <GearIcon />
            </button>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {entries.map((e) =>
          started[e.id] ? (
            <div
              key={e.id}
              className={cn(
                "absolute inset-0 overflow-hidden",
                e.id !== active && "hidden",
              )}
            >
              <TerminalPanel
                id={ptyId(e)}
                encoded={encoded}
                subPath={e.subPath}
                showHeader={false}
                initialCommand={e.command.trim()}
                visible={visible && e.id === active}
                fitSignal={fitSignal}
              />
            </div>
          ) : null,
        )}

        {activeEntry && !started[activeEntry.id] && (
          <div className="group absolute inset-0 flex flex-col items-center justify-center bg-[var(--bg)] px-6 text-center">
            <button
              onClick={() => startEntry(activeEntry.id)}
              disabled={!activeEntry.command.trim()}
              title={
                activeEntry.command.trim()
                  ? `Run: ${activeEntry.command.trim()}`
                  : "Set a command first"
              }
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1 font-[family-name:var(--font-mono)] text-[12px] font-medium transition-colors",
                activeEntry.command.trim()
                  ? "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
                  : "cursor-not-allowed border border-[var(--border)] text-[var(--text-tertiary)]",
              )}
            >
              <PlayIcon />
              {label}
            </button>
            {/* No header in this state (single idle command) — same quiet,
                always-visible edit gear, pinned to the corner. */}
            {!showHeader && (
              <button
                onClick={onConfigure}
                title={`Edit ${label.toLowerCase()} commands`}
                aria-label={`Edit ${label.toLowerCase()} commands`}
                className={cn("absolute top-2 right-2", gearBtnCls)}
              >
                <GearIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
