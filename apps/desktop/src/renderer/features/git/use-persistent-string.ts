import { useCallback, useState } from "react";

/**
 * A string persisted to localStorage under `key`, seeded from `fallback`. Used
 * for small UI mode preferences (e.g. the Diffs list/tree view mode) so a
 * user's choice sticks across reloads. `allowed`, if given, rejects any stored
 * value not in the set — guards against a stale/garbage value lingering after a
 * mode is renamed or removed.
 */
export function usePersistentString<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): readonly [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    const stored = window.localStorage.getItem(key) as T | null;
    if (stored == null) return fallback;
    if (allowed && !allowed.includes(stored)) return fallback;
    return stored;
  });

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* storage unavailable — keep the in-memory value */
      }
    },
    [key],
  );

  return [value, set] as const;
}
