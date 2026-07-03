import { useCallback, useState } from "react";

/**
 * A number persisted to localStorage under `key`, seeded from `fallback`. Used
 * for resizable panel sizes (sidebar widths, terminal heights) so a user's drag
 * sticks across reloads.
 */
export function usePersistentNumber(
  key: string,
  fallback: number,
): readonly [number, (v: number) => void] {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return fallback;
    const stored = window.localStorage.getItem(key);
    const n = stored == null ? NaN : Number(stored);
    return Number.isFinite(n) ? n : fallback;
  });

  const set = useCallback(
    (v: number) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, String(v));
      } catch {
        /* storage unavailable — keep the in-memory value */
      }
    },
    [key],
  );

  return [value, set] as const;
}
