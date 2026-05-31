import { cn } from "@plan/shared/lib/utils";
import { relativeTime } from "../lib/time";

export interface SessionListItem {
  sessionId: string;
  title: string | null;
  updatedAt: number | string | null;
  messageCount: number;
}

interface Props {
  sessions: SessionListItem[];
  selected: string | null;
  onSelect: (sessionId: string) => void;
  loading?: boolean;
}

export function SessionList({ sessions, selected, onSelect, loading }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        Recent sessions
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            No sessions
          </div>
        ) : (
          <div className="flex flex-col">
            {sessions.map((s) => {
              const isSelected = s.sessionId === selected;
              return (
                <button
                  key={s.sessionId}
                  onClick={() => onSelect(s.sessionId)}
                  className={cn(
                    "flex flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]"
                      : "border-l-transparent hover:bg-[var(--bg-surface-hover)]"
                  )}
                >
                  <span
                    className={cn(
                      "truncate font-[family-name:var(--font-mono)] text-[12px]",
                      isSelected
                        ? "text-[var(--text)]"
                        : "text-[var(--text-secondary)]"
                    )}
                  >
                    {s.title ?? "Untitled session"}
                  </span>
                  <div className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                    <span>{relativeTime(s.updatedAt)}</span>
                    <span>·</span>
                    <span>
                      {s.messageCount} msg{s.messageCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
