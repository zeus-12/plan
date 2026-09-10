import { useSyncExternalStore } from "react";
import type { ChatFolder } from "@/common/shared-types";
import { sameJson } from "@plan/shared/lib/utils";

/**
 * Chat folders per worktree `encoded`, as main last reported them. Main owns
 * the invariants (one folder per chat, no empty folders) and every call answers
 * with the full list, so this only ever holds a confirmed state. Module scope so
 * a worktree switch remounts straight into its folders.
 */

const EMPTY: ChatFolder[] = [];
const folders = new Map<string, ChatFolder[]>();
const issued = new Map<string, number>();
const applied = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function request(
  encoded: string,
  call: () => Promise<ChatFolder[]>,
): Promise<void> {
  const seq = (issued.get(encoded) ?? 0) + 1;
  issued.set(encoded, seq);
  const next = await call();
  // A sync issued before a mutation can resolve after it; its older answer
  // must not overwrite the mutation's.
  if (seq < (applied.get(encoded) ?? 0)) return;
  applied.set(encoded, seq);
  if (sameJson(folders.get(encoded), next)) return;
  folders.set(encoded, next);
  listeners.forEach((l) => l());
}

export function useChatFolders(encoded: string): ChatFolder[] {
  return useSyncExternalStore(
    subscribe,
    () => folders.get(encoded) ?? EMPTY,
    () => EMPTY,
  );
}

export function syncChatFolders(encoded: string): Promise<void> {
  return request(encoded, () => window.electronAPI.listChatFolders(encoded));
}

export function createChatFolder(
  encoded: string,
  name: string,
  sessionId: string,
): Promise<void> {
  return request(encoded, () =>
    window.electronAPI.createChatFolder(encoded, name, sessionId),
  );
}

export function renameChatFolder(
  encoded: string,
  folderId: string,
  name: string,
): Promise<void> {
  return request(encoded, () =>
    window.electronAPI.renameChatFolder(encoded, folderId, name),
  );
}

export function setChatFolderCollapsed(
  encoded: string,
  folderId: string,
  collapsed: boolean,
): Promise<void> {
  return request(encoded, () =>
    window.electronAPI.setChatFolderCollapsed(encoded, folderId, collapsed),
  );
}

export function ungroupChatFolder(
  encoded: string,
  folderId: string,
): Promise<void> {
  return request(encoded, () =>
    window.electronAPI.ungroupChatFolder(encoded, folderId),
  );
}

export function moveChatToFolder(
  encoded: string,
  sessionId: string,
  folderId: string | null,
): Promise<void> {
  return request(encoded, () =>
    window.electronAPI.moveChatToFolder(encoded, sessionId, folderId),
  );
}
