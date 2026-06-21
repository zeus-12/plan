import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import { useTerminalWorking } from "../lib/terminal-activity-store";

interface TerminalInfo {
  id: string;
  cwd: string;
  pid: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Jump to a chat session (project + session id). */
  onNavigate: (encoded: string, sessionId: string) => void;
}

type Parsed =
  | { kind: "chat"; encoded: string; sessionId: string }
  | { kind: "shell"; encoded: string; n: string }
  | { kind: "other" };

function parseId(id: string): Parsed {
  let m = id.match(/^chat:(.+):([^:]+)$/);
  if (m) return { kind: "chat", encoded: m[1], sessionId: m[2] };
  m = id.match(/^term:(.+):([^:]+)$/);
  if (m) return { kind: "shell", encoded: m[1], n: m[2] };
  return { kind: "other" };
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/**
 * Control-center modal listing every live pty the app is keeping alive — its
 * real `claude` (and scratch-shell) processes — straight from the main process's
 * own session map. Click a row to jump to that chat; "Kill" stops it.
 *
 * The list is the source of truth (main's running ptys); we never show a row for
 * something that isn't actually running. Killed rows vanish only once main
 * confirms the exit, not optimistically.
 */
export function SessionsDashboard({ open, onClose, onNavigate }: Props) {
  const [items, setItems] = useState<TerminalInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.electronAPI.terminalList();
      setItems(list);
      setError(null);
    } catch (e) {
      // Don't fabricate "0 running" on failure — say we couldn't read it.
      // (Most likely the main process is stale: restart the app to pick up
      // the terminal:list handler.)
      setError(e instanceof Error ? e.message : "Failed to read sessions");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const interval = setInterval(refresh, 2000);
    // A pty exiting (kill, `exit`, eviction) should reflect immediately.
    const offExit = window.electronAPI.onTerminalExit(() => void refresh());
    return () => {
      clearInterval(interval);
      offExit();
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const kill = useCallback((id: string) => {
    window.electronAPI.terminalKill(id);
    // No optimistic removal — the terminal:exit refresh confirms it's gone.
  }, []);

  const rows = useMemo(
    () => items.map((t) => ({ ...t, parsed: parseId(t.id) })),
    [items]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[min(560px,86vw)] flex-col overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            Running Claude sessions · {error ? "?" : rows.length}
          </span>
          <button
            onClick={onClose}
            className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text)]"
          >
            esc
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {error ? (
            <div className="px-3 py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-amber-500">
              Couldn&apos;t read running sessions — try restarting the app.
              <br />
              <span className="text-[var(--text-tertiary)]">{error}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
              No live sessions. Connecting a chat starts one.
            </div>
          ) : (
            rows.map((r) => (
              <SessionRow
                key={r.id}
                id={r.id}
                cwd={r.cwd}
                pid={r.pid}
                parsed={r.parsed}
                onKill={() => kill(r.id)}
                onOpen={
                  r.parsed.kind === "chat"
                    ? () => {
                        const p = r.parsed as {
                          encoded: string;
                          sessionId: string;
                        };
                        onNavigate(p.encoded, p.sessionId);
                      }
                    : undefined
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SessionRow({
  id,
  cwd,
  pid,
  parsed,
  onKill,
  onOpen,
}: {
  id: string;
  cwd: string;
  pid: number;
  parsed: Parsed;
  onKill: () => void;
  /** Present for chat rows — clicking the row opens that session. */
  onOpen?: () => void;
}) {
  const working = useTerminalWorking(id);
  const label =
    parsed.kind === "chat"
      ? `${parsed.sessionId.slice(0, 8)}`
      : parsed.kind === "shell"
        ? `shell ${parsed.n}`
        : id;

  return (
    <div
      onClick={onOpen}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-[var(--bg-surface-hover)]",
        onOpen && "cursor-pointer"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          working ? "animate-pulse bg-emerald-500" : "bg-[var(--text-tertiary)]"
        )}
        title={working ? "Working" : "Idle"}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
          {projectName(cwd)}
          <span className="text-[var(--text-tertiary)]"> · {label}</span>
        </span>
        <span className="truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {parsed.kind === "chat" ? "claude" : "shell"} · pid {pid}
        </span>
      </div>
      <button
        onClick={(e) => {
          // Don't also trigger the row's open handler.
          e.stopPropagation();
          onKill();
        }}
        className="shrink-0 cursor-pointer rounded-md bg-red-500 px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-white transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
      >
        Kill
      </button>
    </div>
  );
}
