import { useEffect } from "react";

/**
 * Cross-component "select this session" request, used by the sessions dashboard
 * to jump to a chat.
 *
 * Switching project remounts ProjectWorkspace, which reads its persisted
 * selection from localStorage — so cross-project jumps need no store. This
 * covers the OTHER case: the target chat lives in the already-open project,
 * whose workspace is mounted and must be told to switch sessions in place.
 */
type Target = { encoded: string; sessionId: string };

const listeners = new Set<(t: Target) => void>();

export function requestSessionNav(encoded: string, sessionId: string) {
  listeners.forEach((l) => l({ encoded, sessionId }));
}

/** Fire `onTarget` when a nav request for `encoded` arrives. */
export function useSessionNavTarget(
  encoded: string,
  onTarget: (sessionId: string) => void
) {
  useEffect(() => {
    const l = (t: Target) => {
      if (t.encoded === encoded) onTarget(t.sessionId);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [encoded, onTarget]);
}
