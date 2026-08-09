import { memo } from "react";
import { cn } from "@plan/shared/lib/utils";
import { chatTerminalId } from "@/common/terminal-ids";
import { TimeAgo } from "@/renderer/components/time-ago";
import { useChatWorking } from "./session-activity-store";
import { useSessionNeedsApproval } from "./session-approval-store";
import {
  useSessionHasUnread,
  markSessionUnread,
  clearSessionUnread,
} from "./unread-response-store";
import { WorkingIcon } from "./working-icon";
import { ApprovalDot } from "./approval-dot";
import { RepliedDot } from "./replied-dot";

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
import { ChevronLeft } from "@/renderer/components/chevron";
import { ListFooter, ListFooterIcon } from "@/renderer/components/list-footer";

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
  /** Project encoded dir — used to build each session's terminal id. */
  encoded: string;
  onSelect: (sessionId: string) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  /** Move a chat to another worktree (or the live copy). Omitted = no targets. */
  onMoveSession?: (sessionId: string, title: string) => void;
  onNewChat: () => void;
  loading?: boolean;
}

export function SessionList({
  sessions,
  selected,
  encoded,
  onSelect,
  onSetArchived,
  onRename,
  onMoveSession,
  onNewChat,
  loading,
}: Props) {
  // When true the list transforms into an archived-only view.
  const [archivedView, setArchivedView] = useState(false);
  // Free-text filter for the archived view (title substring match).
  const [archivedSearch, setArchivedSearch] = useState("");

  const { active, archived } = useMemo(() => {
    const a: SessionListItem[] = [];
    const ar: SessionListItem[] = [];
    for (const s of sessions) (s.archived ? ar : a).push(s);
    return { active: a, archived: ar };
  }, [sessions]);

  // Leave the archived view automatically once it's empty; drop any stale
  // filter text whenever we're back on the active list.
  useEffect(() => {
    if (!archivedView && archivedSearch) setArchivedSearch("");
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length, archivedSearch]);

  const shown = useMemo(() => {
    if (!archivedView) return active;
    const q = archivedSearch.trim().toLowerCase();
    if (!q) return archived;
    return archived.filter((s) =>
      (s.title ?? "Untitled session").toLowerCase().includes(q),
    );
  }, [archivedView, active, archived, archivedSearch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {archivedView ? (
        <button
          onClick={() => setArchivedView(false)}
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
          title="Back to sessions"
        >
          <ChevronLeft size={13} />
          <span className="flex-1">Archived chats</span>
          <span>{archived.length}</span>
        </button>
      ) : null}
      {archivedView && (
        <div className="shrink-0 border-b border-[var(--border)] px-2 py-1.5">
          <input
            value={archivedSearch}
            onChange={(e) => setArchivedSearch(e.target.value)}
            placeholder="Search archived chats"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && sessions.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {archivedView
              ? archivedSearch.trim()
                ? "No matching chats"
                : "No archived chats"
              : "No sessions"}
          </div>
        ) : (
          <div className="flex flex-col">
            {shown.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                isSelected={s.sessionId === selected}
                termId={chatTerminalId(encoded, s.sessionId)}
                onSelect={onSelect}
                onRename={onRename}
                onSetArchived={onSetArchived}
                onMoveSession={onMoveSession}
              />
            ))}
          </div>
        )}
      </div>
      {/* The fade lives above it, never on it (mirrors the first sidebar's
          "Add project" footer). */}
      <ListFooter
        label="New chat"
        onClick={onNewChat}
        trailing={
          archived.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <ListFooterIcon
                  label="Archived chats"
                  active={archivedView}
                  onClick={() => setArchivedView((v) => !v)}
                >
                  <TrashIcon />
                </ListFooterIcon>
              </TooltipTrigger>
              <TooltipContent side="top">
                {archivedView ? "Back to sessions" : "Archived chats"}
              </TooltipContent>
            </Tooltip>
          ) : null
        }
      />
    </div>
  );
}

/**
 * One row in the session list. Split out so each can subscribe to its own
 * agent's working-state (a hook). The status indicator sits in a fixed 14px slot
 * at the trailing edge — the three states are different sizes (8px dots, 14px
 * spinner), so without it the title's truncation point would jump every time one
 * appeared, swapped, or cleared.
 */
// Memoized: the list re-renders when `selected` or the sessions array changes,
// but only the rows whose own props actually changed need to re-render (each
// row also subscribes to its own working-state). The parent passes stable
// (useCallback) handlers, so unchanged rows bail out.
const SessionRow = memo(function SessionRow({
  session: s,
  isSelected,
  termId,
  onSelect,
  onRename,
  onSetArchived,
  onMoveSession,
}: {
  session: SessionListItem;
  isSelected: boolean;
  termId: string;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onMoveSession?: (sessionId: string, title: string) => void;
}) {
  const working = useChatWorking(termId);
  // A parked menu wins over the working spinner: the session keeps repainting
  // its prompt while it waits, so both read true — but "waiting on you" is the
  // actionable state, so it's the one to show.
  const needsApproval = useSessionNeedsApproval(termId);
  // Lowest priority of the three: only shown once the turn is genuinely done
  // (not working) and it isn't parked on a menu (not approval).
  const hasUnread = useSessionHasUnread(termId);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => onSelect(s.sessionId)}
          className={cn(
            "flex flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition-colors",
            isSelected
              ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]"
              : "border-l-transparent hover:bg-[var(--bg-surface-hover)]",
          )}
        >
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px]",
                isSelected
                  ? "text-[var(--text)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              {s.title ?? "Untitled session"}
            </span>
            {needsApproval ? (
              <ApprovalDot />
            ) : working ? (
              <WorkingIcon className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
            ) : (
              hasUnread && <RepliedDot />
            )}
          </span>
          <TimeAgo
            ts={s.updatedAt}
            className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]"
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onRename(s.sessionId, s.title ?? "")}>
          Rename…
        </ContextMenuItem>
        {hasUnread ? (
          <ContextMenuItem onSelect={() => clearSessionUnread(termId)}>
            Mark as read
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => markSessionUnread(termId)}>
            Mark as unread
          </ContextMenuItem>
        )}
        {onMoveSession && (
          <ContextMenuItem
            onSelect={() =>
              onMoveSession(s.sessionId, s.title ?? "Untitled session")
            }
          >
            Move to worktree…
          </ContextMenuItem>
        )}
        {s.archived ? (
          <ContextMenuItem onSelect={() => onSetArchived(s.sessionId, false)}>
            Unarchive
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onSetArchived(s.sessionId, true)}>
            Archive
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

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
