"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DiffState {
  left: string;
  right: string;
}

const MAX_HISTORY = 100;
const COALESCE_MS = 800;

interface UndoableOptions {
  /** Initial state — used on mount only. */
  initial?: DiffState;
}

/**
 * Coalescing undo/redo for the two-pane editor. Typing batches every 800ms
 * of idle; merges (or any setBoth/reset) are discrete entries. Cmd+Z and
 * Cmd+Shift+Z bound at the window level.
 *
 * Implementation note: history lives in refs (not React state) so it never
 * tears under batching, and the setter functions own all the side effects.
 * The reactive piece is just `state` and history-length counters.
 */
export function useUndoable({ initial }: UndoableOptions = {}) {
  const initialState: DiffState = initial ?? { left: "", right: "" };

  const [state, setState] = useState<DiffState>(initialState);
  // Mirrored counters so canUndo/canRedo are reactive.
  const [pastLen, setPastLen] = useState(0);
  const [futureLen, setFutureLen] = useState(0);

  const pastRef = useRef<DiffState[]>([]);
  const futureRef = useRef<DiffState[]>([]);
  const presentRef = useRef<DiffState>(initialState);
  const coalesceActiveRef = useRef(false);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopCoalesceTimer = useCallback(() => {
    if (coalesceTimerRef.current) {
      clearTimeout(coalesceTimerRef.current);
      coalesceTimerRef.current = null;
    }
  }, []);

  const armCoalesceTimer = useCallback(() => {
    stopCoalesceTimer();
    coalesceTimerRef.current = setTimeout(() => {
      coalesceActiveRef.current = false;
      coalesceTimerRef.current = null;
    }, COALESCE_MS);
  }, [stopCoalesceTimer]);

  const applyState = useCallback(
    (next: DiffState, options: { coalesce: boolean }) => {
      const prev = presentRef.current;
      if (prev.left === next.left && prev.right === next.right) return;

      // Any forward future is invalidated by a fresh change.
      futureRef.current = [];

      if (options.coalesce) {
        if (!coalesceActiveRef.current) {
          pastRef.current.push(prev);
          if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
          coalesceActiveRef.current = true;
        }
        armCoalesceTimer();
      } else {
        // Discrete event: close any active typing batch and record this state.
        coalesceActiveRef.current = false;
        stopCoalesceTimer();
        pastRef.current.push(prev);
        if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
      }

      presentRef.current = next;
      setState(next);
      setPastLen(pastRef.current.length);
      setFutureLen(0);
    },
    [armCoalesceTimer, stopCoalesceTimer],
  );

  const setLeft = useCallback(
    (v: string) => {
      applyState({ ...presentRef.current, left: v }, { coalesce: true });
    },
    [applyState],
  );

  const setRight = useCallback(
    (v: string) => {
      applyState({ ...presentRef.current, right: v }, { coalesce: true });
    },
    [applyState],
  );

  const setBoth = useCallback(
    (next: DiffState) => {
      applyState(next, { coalesce: false });
    },
    [applyState],
  );

  const reset = useCallback(
    (next: DiffState) => {
      pastRef.current = [];
      futureRef.current = [];
      presentRef.current = next;
      coalesceActiveRef.current = false;
      stopCoalesceTimer();
      setState(next);
      setPastLen(0);
      setFutureLen(0);
    },
    [stopCoalesceTimer],
  );

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    coalesceActiveRef.current = false;
    stopCoalesceTimer();
    const prev = pastRef.current.pop()!;
    futureRef.current.push(presentRef.current);
    presentRef.current = prev;
    setState(prev);
    setPastLen(pastRef.current.length);
    setFutureLen(futureRef.current.length);
  }, [stopCoalesceTimer]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current.pop()!;
    pastRef.current.push(presentRef.current);
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
    presentRef.current = next;
    setState(next);
    setPastLen(pastRef.current.length);
    setFutureLen(futureRef.current.length);
  }, []);

  // Bind Cmd+Z / Cmd+Shift+Z at the window level.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;
      if (e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  return {
    left: state.left,
    right: state.right,
    setLeft,
    setRight,
    setBoth,
    reset,
    undo,
    redo,
    canUndo: pastLen > 0,
    canRedo: futureLen > 0,
  };
}
