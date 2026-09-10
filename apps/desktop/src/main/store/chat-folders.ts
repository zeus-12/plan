import { randomUUID } from "crypto";
import type { ChatFolder } from "@/common/shared-types";
import { createJsonStore } from "./json-store";

export interface StoredChatFolder extends ChatFolder {
  /** The worktree whose chat list the folder lives in. */
  encoded: string;
}

interface Stored {
  folders: StoredChatFolder[];
}

function sanitizeFolder(raw: unknown): StoredChatFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (
    typeof f.id !== "string" ||
    typeof f.encoded !== "string" ||
    typeof f.name !== "string"
  )
    return null;
  const sessionIds = Array.isArray(f.sessionIds)
    ? f.sessionIds.filter((s): s is string => typeof s === "string")
    : [];
  if (sessionIds.length === 0) return null;
  return {
    id: f.id,
    encoded: f.encoded,
    name: f.name,
    collapsed: f.collapsed === true,
    sessionIds,
  };
}

const { load, scheduleWrite } = createJsonStore<Stored>(
  "chat-folders.json",
  (raw) => {
    const list =
      raw && typeof raw === "object" && "folders" in raw
        ? (raw as { folders: unknown }).folders
        : null;
    return {
      folders: Array.isArray(list)
        ? list
            .map(sanitizeFolder)
            .filter((f): f is StoredChatFolder => f !== null)
        : [],
    };
  },
);

export function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder name can't be empty");
  return trimmed;
}

/** Take a chat out of every folder; a folder it leaves empty goes with it. */
export function detachChat(
  folders: StoredChatFolder[],
  sessionId: string,
): StoredChatFolder[] {
  if (!folders.some((f) => f.sessionIds.includes(sessionId))) return folders;
  return folders.flatMap((f) => {
    if (!f.sessionIds.includes(sessionId)) return [f];
    const sessionIds = f.sessionIds.filter((s) => s !== sessionId);
    return sessionIds.length > 0 ? [{ ...f, sessionIds }] : [];
  });
}

export function withNewFolder(
  folders: StoredChatFolder[],
  encoded: string,
  name: string,
  sessionId: string,
  id: string,
): StoredChatFolder[] {
  return [
    ...detachChat(folders, sessionId),
    {
      id,
      encoded,
      name: folderName(name),
      collapsed: false,
      sessionIds: [sessionId],
    },
  ];
}

export function withChatMoved(
  folders: StoredChatFolder[],
  encoded: string,
  sessionId: string,
  folderId: string | null,
): StoredChatFolder[] {
  if (folderId === null) return detachChat(folders, sessionId);
  const target = findFolder(folders, encoded, folderId);
  if (target.sessionIds.includes(sessionId)) return folders;
  return detachChat(folders, sessionId).map((f) =>
    f === target ? { ...f, sessionIds: [...f.sessionIds, sessionId] } : f,
  );
}

export function withFolderUpdated(
  folders: StoredChatFolder[],
  encoded: string,
  folderId: string,
  patch: Partial<Pick<ChatFolder, "name" | "collapsed">>,
): StoredChatFolder[] {
  const target = findFolder(folders, encoded, folderId);
  const next = {
    ...target,
    ...patch,
    ...(patch.name !== undefined && { name: folderName(patch.name) }),
  };
  return folders.map((f) => (f === target ? next : f));
}

export function foldersFor(
  folders: StoredChatFolder[],
  encoded: string,
): ChatFolder[] {
  return folders
    .filter((f) => f.encoded === encoded)
    .map(({ id, name, collapsed, sessionIds }) => ({
      id,
      name,
      collapsed,
      sessionIds,
    }));
}

function findFolder(
  folders: StoredChatFolder[],
  encoded: string,
  folderId: string,
): StoredChatFolder {
  const found = folders.find((f) => f.id === folderId && f.encoded === encoded);
  if (!found) throw new Error("That folder no longer exists");
  return found;
}

async function commit(
  encoded: string,
  change: (folders: StoredChatFolder[]) => StoredChatFolder[],
): Promise<ChatFolder[]> {
  const data = await load();
  const next = change(data.folders);
  if (next !== data.folders) {
    data.folders = next;
    scheduleWrite();
  }
  return foldersFor(data.folders, encoded);
}

export function listChatFolders(encoded: string): Promise<ChatFolder[]> {
  return commit(encoded, (folders) => folders);
}

export function createChatFolder(
  encoded: string,
  name: string,
  sessionId: string,
): Promise<ChatFolder[]> {
  return commit(encoded, (folders) =>
    withNewFolder(folders, encoded, name, sessionId, randomUUID()),
  );
}

export function renameChatFolder(
  encoded: string,
  folderId: string,
  name: string,
): Promise<ChatFolder[]> {
  return commit(encoded, (folders) =>
    withFolderUpdated(folders, encoded, folderId, { name }),
  );
}

export function setChatFolderCollapsed(
  encoded: string,
  folderId: string,
  collapsed: boolean,
): Promise<ChatFolder[]> {
  return commit(encoded, (folders) =>
    withFolderUpdated(folders, encoded, folderId, { collapsed }),
  );
}

export function ungroupChatFolder(
  encoded: string,
  folderId: string,
): Promise<ChatFolder[]> {
  return commit(encoded, (folders) => {
    const target = findFolder(folders, encoded, folderId);
    return folders.filter((f) => f !== target);
  });
}

export function moveChatToFolder(
  encoded: string,
  sessionId: string,
  folderId: string | null,
): Promise<ChatFolder[]> {
  return commit(encoded, (folders) =>
    withChatMoved(folders, encoded, sessionId, folderId),
  );
}

/** For a chat leaving its list (archived or moved to another worktree). */
export async function removeChatFromFolders(sessionId: string): Promise<void> {
  const data = await load();
  const next = detachChat(data.folders, sessionId);
  if (next === data.folders) return;
  data.folders = next;
  scheduleWrite();
}

export async function dropChatFoldersFor(encoded: string): Promise<void> {
  const data = await load();
  const next = data.folders.filter((f) => f.encoded !== encoded);
  if (next.length === data.folders.length) return;
  data.folders = next;
  scheduleWrite();
}
