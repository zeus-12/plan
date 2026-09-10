import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { cn } from "@plan/shared/lib/utils";
import type { ChatFolder } from "@/common/shared-types";
import { chatTerminalId } from "@/common/terminal-ids";
import { TimeAgo } from "@/renderer/components/time-ago";
import { RenameDialog } from "@/renderer/components/rename-dialog";
import { pushToast } from "@/renderer/lib/toast-store";
import { useAnyChatWorking, useChatWorking } from "./session-activity-store";
import {
  useAnySessionNeedsApproval,
  useSessionNeedsApproval,
} from "./session-approval-store";
import {
  useAnySessionHasUnread,
  useSessionHasUnread,
  markSessionUnread,
  clearSessionUnread,
} from "./unread-response-store";
import {
  createChatFolder,
  moveChatToFolder,
  renameChatFolder,
  setChatFolderCollapsed,
  syncChatFolders,
  ungroupChatFolder,
  useChatFolders,
} from "./chat-folders-store";
import { WorkingIcon } from "./working-icon";
import { ApprovalDot } from "./approval-dot";
import { RepliedDot } from "./replied-dot";
import { StatusDots } from "./status-dots";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@plan/shared/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { Chevron, ChevronLeft } from "@/renderer/components/chevron";
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
  encoded: string;
  onSelect: (sessionId: string) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  /** Omitted = no other worktree to move to. */
  onMoveSession?: (sessionId: string, title: string) => void;
  onNewChat: () => void;
  loading?: boolean;
}

interface FolderGroup {
  folder: ChatFolder;
  chats: SessionListItem[];
}

interface FolderTarget {
  id: string;
  name: string;
}

type FolderDialog =
  | { kind: "create"; sessionId: string }
  | { kind: "rename"; folderId: string; name: string };

const LOOSE = "loose";
const NO_IDS: string[] = [];

function reportFolderError(err: unknown) {
  pushToast({
    title: "Couldn't update chat folders",
    description: err instanceof Error ? err.message : String(err),
    id: "chat-folders-failed",
  });
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
  const [archivedView, setArchivedView] = useState(false);
  const [archivedSearch, setArchivedSearch] = useState("");
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);
  const [dragging, setDragging] = useState<{
    sessionId: string;
    from: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const folders = useChatFolders(encoded);

  const { active, archived } = useMemo(() => {
    const a: SessionListItem[] = [];
    const ar: SessionListItem[] = [];
    for (const s of sessions) (s.archived ? ar : a).push(s);
    return { active: a, archived: ar };
  }, [sessions]);

  useEffect(() => {
    if (!archivedView && archivedSearch) setArchivedSearch("");
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length, archivedSearch]);

  // Main drops a chat's folder when it's archived or moved away, so re-read
  // whenever the set of listed chats changes.
  const rosterKey = useMemo(
    () => active.map((s) => s.sessionId).join("\n"),
    [active],
  );
  useEffect(() => {
    syncChatFolders(encoded).catch(reportFolderError);
  }, [encoded, rosterKey]);

  const { groups, loose } = useMemo(() => {
    const folderOf = new Map<string, string>();
    for (const f of folders)
      for (const id of f.sessionIds)
        if (!folderOf.has(id)) folderOf.set(id, f.id);
    const members = new Map<string, SessionListItem[]>();
    const rest: SessionListItem[] = [];
    for (const s of active) {
      const fid = folderOf.get(s.sessionId);
      if (fid === undefined) {
        rest.push(s);
        continue;
      }
      const list = members.get(fid);
      if (list) list.push(s);
      else members.set(fid, [s]);
    }
    const g: FolderGroup[] = folders.flatMap((folder) => {
      const chats = members.get(folder.id);
      return chats ? [{ folder, chats }] : [];
    });
    return { groups: g, loose: rest };
  }, [folders, active]);

  const folderTargets = useMemo<FolderTarget[]>(
    () => groups.map((g) => ({ id: g.folder.id, name: g.folder.name })),
    [groups],
  );

  const shown = useMemo(() => {
    if (!archivedView) return active;
    const q = archivedSearch.trim().toLowerCase();
    if (!q) return archived;
    return archived.filter((s) =>
      (s.title ?? "Untitled session").toLowerCase().includes(q),
    );
  }, [archivedView, active, archived, archivedSearch]);

  const handleNewFolder = useCallback(
    (sessionId: string) => setFolderDialog({ kind: "create", sessionId }),
    [],
  );
  const handleMoveToFolder = useCallback(
    (sessionId: string, folderId: string | null) => {
      moveChatToFolder(encoded, sessionId, folderId).catch(reportFolderError);
    },
    [encoded],
  );
  const handleToggleFolder = useCallback(
    (folder: ChatFolder) => {
      setChatFolderCollapsed(encoded, folder.id, !folder.collapsed).catch(
        reportFolderError,
      );
    },
    [encoded],
  );
  const handleRenameFolder = useCallback(
    (folder: ChatFolder) =>
      setFolderDialog({
        kind: "rename",
        folderId: folder.id,
        name: folder.name,
      }),
    [],
  );
  const handleUngroupFolder = useCallback(
    (folder: ChatFolder) => {
      ungroupChatFolder(encoded, folder.id).catch(reportFolderError);
    },
    [encoded],
  );
  const handleDragStart = useCallback(
    (sessionId: string, folderId: string | null) =>
      setDragging({ sessionId, from: folderId ?? LOOSE }),
    [],
  );
  const handleDragEnd = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
  }, []);

  const dropZone = (target: string) => ({
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!dragging || dragging.from === target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropTarget((t) => (t === target ? null : t));
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const d = dragging;
      handleDragEnd();
      if (d) handleMoveToFolder(d.sessionId, target === LOOSE ? null : target);
    },
  });

  const renderRow = (s: SessionListItem, folderId: string | null) => (
    <SessionRow
      key={s.sessionId}
      session={s}
      isSelected={s.sessionId === selected}
      termId={chatTerminalId(encoded, s.sessionId)}
      nested={folderId !== null}
      canGroup={!archivedView}
      folderId={folderId}
      folderTargets={folderTargets}
      onSelect={onSelect}
      onRename={onRename}
      onSetArchived={onSetArchived}
      onMoveSession={onMoveSession}
      onNewFolder={handleNewFolder}
      onMoveToFolder={handleMoveToFolder}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    />
  );

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
      <div className="scrollbar-hidden-y min-h-0 flex-1 overflow-auto">
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
        ) : archivedView ? (
          <div className="flex flex-col">
            {shown.map((s) => renderRow(s, null))}
          </div>
        ) : (
          <div className="flex min-h-full flex-col">
            {groups.map(({ folder, chats }) => (
              <div
                key={folder.id}
                className={cn(
                  "flex flex-col transition-colors",
                  dropTarget === folder.id && "bg-[var(--bg-surface-hover)]",
                )}
                {...dropZone(folder.id)}
              >
                <FolderHeader
                  folder={folder}
                  chats={chats}
                  encoded={encoded}
                  holdsSelected={chats.some((c) => c.sessionId === selected)}
                  onToggle={handleToggleFolder}
                  onRename={handleRenameFolder}
                  onUngroup={handleUngroupFolder}
                />
                {!folder.collapsed && chats.map((s) => renderRow(s, folder.id))}
              </div>
            ))}
            <div
              className={cn(
                "flex flex-1 flex-col transition-colors",
                groups.length > 0 && "border-t border-[var(--border)]",
                dragging && loose.length === 0 && "min-h-12",
                dropTarget === LOOSE && "bg-[var(--bg-surface-hover)]",
              )}
              {...dropZone(LOOSE)}
            >
              {loose.map((s) => renderRow(s, null))}
            </div>
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
      {folderDialog?.kind === "create" && (
        <RenameDialog
          title="New folder"
          placeholder="Folder name"
          initialName=""
          requireName
          onSave={(name) =>
            createChatFolder(encoded, name, folderDialog.sessionId)
          }
          onClose={() => setFolderDialog(null)}
        />
      )}
      {folderDialog?.kind === "rename" && (
        <RenameDialog
          title="Rename folder"
          placeholder="Folder name"
          initialName={folderDialog.name}
          requireName
          onSave={(name) =>
            renameChatFolder(encoded, folderDialog.folderId, name)
          }
          onClose={() => setFolderDialog(null)}
        />
      )}
    </div>
  );
}

const FolderHeader = memo(function FolderHeader({
  folder,
  chats,
  encoded,
  holdsSelected,
  onToggle,
  onRename,
  onUngroup,
}: {
  folder: ChatFolder;
  chats: SessionListItem[];
  encoded: string;
  holdsSelected: boolean;
  onToggle: (folder: ChatFolder) => void;
  onRename: (folder: ChatFolder) => void;
  onUngroup: (folder: ChatFolder) => void;
}) {
  // Expanded, each chat shows its own status; collapsed, the header stands in.
  const rolledUp = useMemo(
    () =>
      folder.collapsed
        ? chats.map((c) => chatTerminalId(encoded, c.sessionId))
        : NO_IDS,
    [folder.collapsed, chats, encoded],
  );
  const approval = useAnySessionNeedsApproval(rolledUp);
  const unread = useAnySessionHasUnread(rolledUp);
  const working = useAnyChatWorking(rolledUp);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => onToggle(folder)}
          aria-expanded={!folder.collapsed}
          className={cn(
            "flex items-center gap-1.5 border-l-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-surface-hover)]",
            folder.collapsed && holdsSelected
              ? "border-l-[var(--accent)]"
              : "border-l-transparent",
          )}
        >
          <Chevron
            open={!folder.collapsed}
            className="text-[var(--text-tertiary)]"
          />
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
            {folder.name}
          </span>
          <StatusDots approval={approval} unread={unread} working={working} />
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {chats.length}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onRename(folder)}>
          Rename…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onUngroup(folder)}>
          Ungroup
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

// Memoized, so handlers must be stable. The status slot is a fixed 14px so the
// title's truncation point doesn't jump between 8px dots and the 14px spinner.
const SessionRow = memo(function SessionRow({
  session: s,
  isSelected,
  termId,
  nested,
  canGroup,
  folderId,
  folderTargets,
  onSelect,
  onRename,
  onSetArchived,
  onMoveSession,
  onNewFolder,
  onMoveToFolder,
  onDragStart,
  onDragEnd,
}: {
  session: SessionListItem;
  isSelected: boolean;
  termId: string;
  nested: boolean;
  canGroup: boolean;
  folderId: string | null;
  folderTargets: FolderTarget[];
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, currentTitle: string) => void;
  onSetArchived: (sessionId: string, archived: boolean) => void;
  onMoveSession?: (sessionId: string, title: string) => void;
  onNewFolder: (sessionId: string) => void;
  onMoveToFolder: (sessionId: string, folderId: string | null) => void;
  onDragStart: (sessionId: string, folderId: string | null) => void;
  onDragEnd: () => void;
}) {
  const working = useChatWorking(termId);
  // A parked menu wins over the working spinner: the session keeps repainting
  // while it waits, so both read true, but "waiting on you" is the actionable one.
  const needsApproval = useSessionNeedsApproval(termId);
  const hasUnread = useSessionHasUnread(termId);
  const otherFolders = folderTargets.filter((f) => f.id !== folderId);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => onSelect(s.sessionId)}
          draggable={canGroup}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-plan-chat", s.sessionId);
            onDragStart(s.sessionId, folderId);
          }}
          onDragEnd={onDragEnd}
          className={cn(
            "flex flex-col gap-0.5 border-l-2 py-2 pr-3 text-left transition-colors",
            nested ? "pl-7" : "pl-3",
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
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {needsApproval ? (
                <ApprovalDot />
              ) : working ? (
                <WorkingIcon className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
              ) : (
                hasUnread && <RepliedDot />
              )}
            </span>
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
        {canGroup &&
          (otherFolders.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Move to folder</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {otherFolders.map((f) => (
                  <ContextMenuItem
                    key={f.id}
                    onSelect={() => onMoveToFolder(s.sessionId, f.id)}
                  >
                    <span className="truncate">{f.name}</span>
                  </ContextMenuItem>
                ))}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onNewFolder(s.sessionId)}>
                  New folder…
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : (
            <ContextMenuItem onSelect={() => onNewFolder(s.sessionId)}>
              Move to new folder…
            </ContextMenuItem>
          ))}
        {canGroup && folderId !== null && (
          <ContextMenuItem onSelect={() => onMoveToFolder(s.sessionId, null)}>
            Remove from folder
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
