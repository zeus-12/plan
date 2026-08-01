import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useProjectTerminals } from "./terminal-store";
import { rekeyChat } from "@/renderer/features/chat/session/chat-driver-store";
import { relocateSessionUnread } from "@/renderer/features/sessions/unread-response-store";
import {
  chatTerminalPrefix,
  shellTerminalId,
  shellTerminalPrefix,
} from "@/common/terminal-ids";

/**
 * One project workspace's registry of live terminal PANES. Owns which pty ids
 * are mounted in the dock, scratch-shell numbering + lifecycle, and the single
 * exit-cleanup path (a pty dying anywhere — `exit`, an archive-kill — keeps the
 * renderer's view in sync).
 *
 * Panes only, not chats: what drives a Claude session, and whether it even has
 * a terminal, belongs to its engine (see chat-driver-store / chat-engines.ts).
 * A chat pane is mounted here when — and only when — its engine reported one.
 *
 * The view-state itself lives in terminal-store (module scope, so it survives
 * workspace remounts); this hook is the behavior around it. Chat-exit policy
 * stays with the caller via `onChatExit` (the workspace decides what happens
 * to the dock when the active chat's driver dies).
 */
export function useTerminalRegistry(
  encoded: string,
  onChatExit: (tid: string) => void,
): {
  /** Pty ids kept mounted in the dock (hidden when inactive). */
  openedIds: string[];
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  /** Scratch shells (sidebar Terminals section), in sidebar order. */
  shells: string[];
  activeShellId: string | null;
  setActiveShellId: Dispatch<SetStateAction<string | null>>;
  /** Mount a pty's pane (no-op if already opened). */
  ensureOpened: (tid: string) => void;
  /** Follow a live chat that migrated to a new session id: re-key it in main
   *  and in the opened set, in place. Resolves false if there was nothing to
   *  follow — the caller must not repoint the UI then. */
  rekeyChatTerminal: (oldTid: string, newTid: string) => Promise<boolean>;
  /** A scratch shell's display number (from its pty id). */
  shellNumber: (id: string) => number;
  newShell: () => void;
  selectShell: (id: string) => void;
  /** Kill the pty and drop the shell from the sidebar. */
  closeShell: (id: string) => void;
} {
  const {
    openedIds,
    setOpenedIds,
    terminalOpen,
    setTerminalOpen,
    shells,
    setShells,
    activeShellId,
    setActiveShellId,
  } = useProjectTerminals(encoded);

  const chatPrefix = chatTerminalPrefix(encoded);
  const shellPrefix = shellTerminalPrefix(encoded);

  const ensureOpened = useCallback(
    (tid: string) => {
      setOpenedIds((ids) => (ids.includes(tid) ? ids : [...ids, tid]));
    },
    [setOpenedIds],
  );

  const rekeyChatTerminal = useCallback(
    async (oldTid: string, newTid: string): Promise<boolean> => {
      // Main owns the driver table — rename there first. Only mirror the
      // renderer's view once main confirms, so we never point a pane at a
      // session the driver didn't actually move to.
      const ok = await rekeyChat(oldTid, newTid);
      if (!ok) return false;
      relocateSessionUnread(oldTid, newTid);
      setOpenedIds((ids) =>
        ids.includes(oldTid)
          ? ids.map((id) => (id === oldTid ? newTid : id))
          : ids,
      );
      return true;
    },
    [setOpenedIds],
  );

  // ── Scratch shells ───────────────────────────────────────────
  const shellNumber = useCallback(
    (id: string) => parseInt(id.slice(shellPrefix.length), 10) || 0,
    [shellPrefix],
  );

  const newShell = useCallback(() => {
    // Numbering reuses gaps after closes; the pty behind a reused id is fresh.
    const n = shells.reduce((m, id) => Math.max(m, shellNumber(id)), 0) + 1;
    const id = shellTerminalId(encoded, n);
    setShells((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveShellId(id);
  }, [shells, shellNumber, encoded, setShells, setActiveShellId]);

  const selectShell = useCallback(
    (id: string) => {
      setActiveShellId(id);
    },
    [setActiveShellId],
  );

  const removeShell = useCallback(
    (id: string) => {
      const remaining = shells.filter((x) => x !== id);
      setShells(remaining);
      // Closing the shown shell falls back to the most recent remaining one.
      setActiveShellId((cur) =>
        cur === id ? (remaining[remaining.length - 1] ?? null) : cur,
      );
    },
    [shells, setShells, setActiveShellId],
  );

  const closeShell = useCallback(
    (id: string) => {
      window.electronAPI.terminalKill(id);
      removeShell(id);
    },
    [removeShell],
  );

  // A pty exiting — typing `exit`, archive-kill, or future idle eviction —
  // removes its entry. This is the single cleanup path for panes, so killing a
  // pty from anywhere keeps the renderer's view (shells) in sync.
  useEffect(
    () =>
      window.electronAPI.onTerminalExit((id) => {
        if (id.startsWith(shellPrefix)) removeShell(id);
      }),
    [shellPrefix, removeShell],
  );

  // A chat's driver ending unmounts its pane (if it had one) and hands the
  // decision about the dock back to the workspace.
  const onChatExitRef = useRef(onChatExit);
  onChatExitRef.current = onChatExit;
  useEffect(
    () =>
      window.electronAPI.onChatExit((id) => {
        if (!id.startsWith(chatPrefix)) return;
        setOpenedIds((ids) => ids.filter((x) => x !== id));
        onChatExitRef.current(id);
      }),
    [chatPrefix, setOpenedIds],
  );

  return {
    openedIds,
    terminalOpen,
    setTerminalOpen,
    shells,
    activeShellId,
    setActiveShellId,
    ensureOpened,
    rekeyChatTerminal,
    shellNumber,
    newShell,
    selectShell,
    closeShell,
  };
}
