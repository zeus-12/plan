import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import type { CommandEntry, DiscoveredRepo } from "@/common/shared-types";
import { commandTerminalId } from "@/common/terminal-ids";
import { TerminalPanel } from "./terminal-panel";
import { entryLabel } from "./commands";

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
  /** Open the terminal settings on this tab's section (the strip's single gear
   *  is the normal way in; this is the empty pane's call to action). */
  onConfigure: () => void;
}

function PlayIcon() {
  return (
    <svg width="8" height="10" viewBox="0 0 9 11" fill="currentColor">
      <path d="M0 0l9 5.5L0 11z" />
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

// How long a kill request waits for main to report the stop before we go ask
// what's actually running. Comfortably past main's SIGHUP → SIGKILL → verify
// escalation, so the normal path is always the exit event, never this.
const KILL_WATCHDOG_MS = 5_000;

// The one prominent action in the header — a proper filled button, not a ghost.
const runBtnCls =
  "flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-[var(--text)] px-2.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90";

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
  // Why an entry's pty couldn't be attached, straight from main's open result.
  // Shown in place of the dead pane a failed spawn would otherwise leave.
  const [openError, setOpenError] = useState<Record<string, string>>({});
  // Entry ids whose next stop (from our own kill) is immediately followed by a
  // fresh start — that's a per-tab "Restart".
  const pendingRestart = useRef<Set<string>>(new Set());
  // Entry ids main has confirmed a live pty for. Only these get reconciled
  // against main's pty table: one that's still mounting hasn't been answered
  // yet and must not be mistaken for a pty that died.
  const confirmed = useRef<Set<string>>(new Set());
  // Kill requests still waiting to be told the pty stopped.
  const killWatchdogs = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Read by callbacks that outlive the render they were made in.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const clearWatchdog = useCallback((id: string) => {
    const t = killWatchdogs.current.get(id);
    if (t) clearTimeout(t);
    killWatchdogs.current.delete(id);
  }, []);

  useEffect(() => {
    const timers = killWatchdogs.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Everything that means "this entry's pty is gone" funnels through here: the
  // real exit event, and a reconcile that found main has no pty under that id.
  const markStopped = useCallback(
    (id: string) => {
      confirmed.current.delete(id);
      clearWatchdog(id);
      setStarted((s) => {
        if (!s[id]) return s;
        const next = { ...s };
        delete next[id];
        return next;
      });
      if (pendingRestart.current.has(id)) {
        pendingRestart.current.delete(id);
        // A separate task, not the same batch: the pane has to actually unmount
        // before it re-mounts, since mounting is what re-runs the command. A
        // timer rather than rAF — rAF doesn't fire while the window is hidden,
        // which strands the restart until the app is brought forward.
        setTimeout(() => setStarted((s) => ({ ...s, [id]: true })), 0);
      }
    },
    [clearWatchdog],
  );

  // Ask main which ptys actually exist, and drop any tab we show as running
  // that doesn't. Without this a single missed `exit` stranded a tab as
  // "running" forever: typing went nowhere and rerun killed a pty main had
  // already forgotten, so nothing happened.
  const reconcile = useCallback(async () => {
    let ptys;
    try {
      ptys = await window.electronAPI.terminalList();
    } catch {
      return; // couldn't ask — leave the view as it is rather than guess
    }
    const live = new Set(ptys.map((t) => t.id));
    for (const e of entriesRef.current) {
      if (
        confirmed.current.has(e.id) &&
        !live.has(commandTerminalId(kind, encoded, e.id))
      ) {
        markStopped(e.id);
      }
    }
  }, [encoded, kind, markStopped]);

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
    // A pending restart belongs to the worktree and entry set it was asked for.
    // Carrying one across a switch would re-run a command in the new worktree
    // that nobody asked to restart.
    pendingRestart.current.clear();
    for (const t of killWatchdogs.current.values()) clearTimeout(t);
    killWatchdogs.current.clear();
    Promise.all(
      entries.map(async (e) => {
        const s = await window.electronAPI.terminalStatus(ptyId(e));
        return [e.id, s.running] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      const live = new Set<string>();
      for (const [id, running] of pairs) {
        if (!running) continue;
        next[id] = true;
        live.add(id);
      }
      confirmed.current = live;
      setStarted(next);
      setOpenError({});
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
        const entry = entriesRef.current.find((e) => ptyId(e) === exited);
        if (entry) markStopped(entry.id);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [encoded, kind, markStopped],
  );

  // Re-check against main whenever this pane comes into view or the window is
  // focused: cheap (one IPC, no process scan) and it heals any tab whose pty
  // died while we weren't listening.
  useEffect(() => {
    if (!visible || !probed) return;
    void reconcile();
    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, probed, reconcile]);

  const startEntry = (id: string) => setStarted((s) => ({ ...s, [id]: true }));
  // (Re)run one command, leaving the others alone: idle → start, running → ask
  // main to stop it, and restart once the stop is confirmed.
  const runEntry = (e: CommandEntry) => {
    if (!e.command.trim()) return;
    if (!started[e.id]) {
      startEntry(e.id);
      return;
    }
    pendingRestart.current.add(e.id);
    window.electronAPI.terminalKill(ptyId(e));
    // Main escalates SIGHUP → SIGKILL and only reports a stop it verified, so
    // this can legitimately take a few seconds. If nothing arrives by then, ask
    // main what's really running rather than waiting on the event forever.
    clearWatchdog(e.id);
    killWatchdogs.current.set(
      e.id,
      setTimeout(() => {
        killWatchdogs.current.delete(e.id);
        void reconcile();
      }, KILL_WATCHDOG_MS),
    );
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
          className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] underline decoration-[var(--border-strong)] underline-offset-4 transition-colors hover:text-[var(--text)]"
        >
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
          <button
            className={cn(runBtnCls, !multi && "ml-auto")}
            onClick={runAll}
            title={multi ? "Run every command" : `Run ${activeEntry.command}`}
          >
            <PlayIcon />
            {runLabel}
          </button>
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
                onOpened={({ error }) => {
                  if (!error) {
                    confirmed.current.add(e.id);
                    setOpenError((prev) =>
                      e.id in prev
                        ? Object.fromEntries(
                            Object.entries(prev).filter(([k]) => k !== e.id),
                          )
                        : prev,
                    );
                    return;
                  }
                  // Nothing was started, so no exit will ever arrive for it.
                  // Drop the pane and say why, rather than leave a dead
                  // terminal that silently swallows everything typed into it.
                  pendingRestart.current.delete(e.id);
                  markStopped(e.id);
                  setOpenError((prev) => ({ ...prev, [e.id]: error }));
                }}
              />
            </div>
          ) : null,
        )}

        {activeEntry && !started[activeEntry.id] && (
          <div className="group absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg)] px-6 text-center">
            {openError[activeEntry.id] && (
              <p className="max-w-[36ch] font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                Couldn&apos;t start: {openError[activeEntry.id]}
              </p>
            )}
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
          </div>
        )}
      </div>
    </div>
  );
}
