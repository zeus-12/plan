import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useProjectTerminals } from "./terminal-store";
import {
  chatTerminalPrefix,
  shellTerminalId,
  shellTerminalPrefix,
} from "../../terminal-ids";

/**
 * One project workspace's registry of live terminal panes. Owns everything
 * between "the workspace wants to talk to a pty" and the TerminalPanel mounts:
 * which pty ids are opened (kept mounted), which are ready, paste delivery
 * that queues until the pty is ready, scratch-shell numbering + lifecycle,
 * and the single exit-cleanup path (a pty dying anywhere — `exit`, an
 * archive-kill — keeps the renderer's view in sync).
 *
 * The view-state itself lives in terminal-store (module scope, so it survives
 * workspace remounts); this hook is the behavior around it. Chat-exit policy
 * stays with the caller via `onChatExit` (the workspace decides what happens
 * to the dock when the active chat's Claude dies).
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
  /** A TerminalPanel finished attaching — flush any queued paste for it. */
  handleTerminalReady: (tid: string) => void;
  /** Send text (+ optional image paths) to a pty, queuing until it's ready. */
  sendToTerminal: (
    tid: string,
    text: string,
    imagePaths: string[],
    submit: boolean,
  ) => void;
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

  // Readiness + queued paste, keyed by pty id. Refs (not state): these only
  // matter at send time, and readiness flips must not re-render the workspace.
  const readyIds = useRef<Set<string>>(new Set());
  const pendingPasteRef = useRef<{
    id: string;
    text: string;
    imagePaths: string[];
    submit: boolean;
  } | null>(null);

  const ensureOpened = useCallback(
    (tid: string) => {
      setOpenedIds((ids) => (ids.includes(tid) ? ids : [...ids, tid]));
    },
    [setOpenedIds],
  );

  const writeToTerminal = (
    tid: string,
    text: string,
    imagePaths: string[],
    submit: boolean,
  ) => {
    if (submit) {
      // Main pastes the body, types any image paths (so Claude attaches them),
      // then sends Enter as a SEPARATE keystroke a beat later — Claude's TUI
      // ignores an Enter bundled with the paste itself.
      window.electronAPI.terminalSubmit(tid, text, imagePaths);
    } else {
      const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
      window.electronAPI.terminalInput(tid, `\x1b[200~${body}\x1b[201~`);
    }
  };

  const handleTerminalReady = useCallback((tid: string) => {
    readyIds.current.add(tid);
    const p = pendingPasteRef.current;
    if (p && p.id === tid) {
      writeToTerminal(p.id, p.text, p.imagePaths, p.submit);
      pendingPasteRef.current = null;
    }
  }, []);

  const sendToTerminal = useCallback(
    (tid: string, text: string, imagePaths: string[], submit: boolean) => {
      if (!text.trim() && imagePaths.length === 0) return;
      ensureOpened(tid);
      if (readyIds.current.has(tid))
        writeToTerminal(tid, text, imagePaths, submit);
      else pendingPasteRef.current = { id: tid, text, imagePaths, submit };
    },
    [ensureOpened],
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
      readyIds.current.delete(id);
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
  // removes its entry. This is the single cleanup path, so killing a pty from
  // anywhere keeps the renderer's view (openedIds / shells) in sync.
  const onChatExitRef = useRef(onChatExit);
  onChatExitRef.current = onChatExit;
  useEffect(
    () =>
      window.electronAPI.onTerminalExit((id) => {
        if (id.startsWith(shellPrefix)) removeShell(id);
        else if (id.startsWith(chatPrefix)) {
          setOpenedIds((ids) => ids.filter((x) => x !== id));
          onChatExitRef.current(id);
        }
      }),
    [shellPrefix, chatPrefix, removeShell, setOpenedIds],
  );

  return {
    openedIds,
    terminalOpen,
    setTerminalOpen,
    shells,
    activeShellId,
    setActiveShellId,
    ensureOpened,
    handleTerminalReady,
    sendToTerminal,
    shellNumber,
    newShell,
    selectShell,
    closeShell,
  };
}
