import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BlameHoverCard } from "./blame-hover-card";
import type { BlameLineInfo } from "./blame";

interface CardState {
  pos: { top: number; left: number };
  info: BlameLineInfo;
}

// Clamp margins match BlameHoverCard's geometry (400px wide, ~340px max tall).
function posFromRect(r: { bottom: number; left: number }) {
  return {
    top: Math.min(r.bottom + 6, window.innerHeight - 360),
    left: Math.max(8, Math.min(r.left, window.innerWidth - 416)),
  };
}

/**
 * The blame hover card, fully assembled: open after a short hover dwell on a
 * chip (or instantly on click), stay open while the pointer is on the chip or
 * the card, close shortly after it leaves both. Callers place `card` in their
 * tree, feed the chip events, and close on scroll/content changes; `encoded` +
 * `path` locate the repo for the lazy full-message fetch.
 */
export function useBlameCard(encoded: string, path: string) {
  const [state, setState] = useState<CardState | null>(null);
  const timer = useRef<number | null>(null);

  const cancelTimer = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => cancelTimer, [cancelTimer]);

  const chipEnter = useCallback(
    (rect: { bottom: number; left: number }, info: BlameLineInfo) => {
      cancelTimer();
      timer.current = window.setTimeout(
        () => setState({ pos: posFromRect(rect), info }),
        350,
      );
    },
    [cancelTimer],
  );
  const chipLeave = useCallback(() => {
    cancelTimer();
    timer.current = window.setTimeout(() => setState(null), 250);
  }, [cancelTimer]);
  const open = useCallback(
    (rect: { bottom: number; left: number }, info: BlameLineInfo) => {
      cancelTimer();
      setState({ pos: posFromRect(rect), info });
    },
    [cancelTimer],
  );
  const close = useCallback(() => {
    cancelTimer();
    setState(null);
  }, [cancelTimer]);

  const card: ReactNode = state ? (
    <BlameHoverCard
      encoded={encoded}
      path={path}
      commit={state.info.commit}
      uncommitted={state.info.uncommitted}
      isYou={state.info.isYou}
      position={state.pos}
      onMouseEnter={cancelTimer}
      onMouseLeave={close}
    />
  ) : null;

  return { card, hasCard: state != null, chipEnter, chipLeave, open, close };
}
