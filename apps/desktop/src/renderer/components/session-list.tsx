import { cn } from "@plan/shared/lib/utils";
import { relativeTime } from "../lib/time";

import { useEffect, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@plan/shared/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { Button } from "@plan/shared/components/ui/button";

export interface SessionListItem {
  sessionId: string;
  title: string | null;
  updatedAt: number | string | null;
  messageCount: number;
  archived: boolean;
}

interface Props {
  sessions: SessionListItem[];
  selected: string | null;
  onSelect: (sessionId: string) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onNewChat: () => void;
  loading?: boolean;
}

export function SessionList({
  sessions,
  selected,
  onSelect,
  onSetArchived,
  onRename,
  onNewChat,
  loading,
}: Props) {
  // When true the list transforms into an archived-only view.
  const [archivedView, setArchivedView] = useState(false);

  const { active, archived } = useMemo(() => {
    const a: SessionListItem[] = [];
    const ar: SessionListItem[] = [];
    for (const s of sessions) (s.archived ? ar : a).push(s);
    return { active: a, archived: ar };
  }, [sessions]);

  // Leave the archived view automatically once it's empty.
  useEffect(() => {
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length]);

  const shown = archivedView ? archived : active;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {archivedView ? (
        <button
          onClick={() => setArchivedView(false)}
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
          title="Back to sessions"
        >
          <ChevronLeftIcon />
          <span className="flex-1">Archived chats</span>
          <span>{archived.length}</span>
        </button>
      ) : (
        <div className="flex shrink-0 items-center border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          Recent sessions
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {archivedView ? "No archived chats" : "No sessions"}
          </div>
        ) : (
          <div className="flex flex-col">
            {shown.map((s) => {
              const isSelected = s.sessionId === selected;
              return (
                <ContextMenu key={s.sessionId}>
                  <ContextMenuTrigger asChild>
                    <button
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
                      <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                        {relativeTime(s.updatedAt)}
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onSelect={() => onRename(s.sessionId, s.title ?? "")}
                    >
                      Rename…
                    </ContextMenuItem>
                    {s.archived ? (
                      <ContextMenuItem
                        onSelect={() => onSetArchived(s.sessionId, false)}
                      >
                        Unarchive
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem
                        onSelect={() => onSetArchived(s.sessionId, true)}
                      >
                        Archive
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>
      {/* Footer: full-width New chat with the archive toggle on the same row
          (mirrors the first sidebar's "Add project" footer). */}
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] p-2">
        <Button
          variant="outline"
          size="sm"
          className="h-9 flex-1 justify-center"
          onClick={onNewChat}
        >
          + New chat
        </Button>
        {archived.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Archived chats"
                onClick={() => setArchivedView((v) => !v)}
                className={cn(
                  archivedView && "border-[var(--accent)] text-[var(--accent)]"
                )}
              >
                <TrashIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {archivedView ? "Back to sessions" : "Archived chats"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function ChevronLeftIcon() {
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
