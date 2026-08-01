"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A settings object persisted to localStorage under `storageKey`. Starts from
 * `defaults` (so SSR and first paint are deterministic), hydrates from storage
 * after mount, and merges stored values over the defaults so newly-added
 * settings pick up their default instead of vanishing.
 */
export function usePersistedSettings<T extends object>(
  storageKey: string,
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [settings, setSettings] = useState<T>(defaults);

  // Hydration keys on the storage key alone; a ref keeps referentially-fresh
  // `defaults` objects from re-running it every render.
  const defaultsRef = useRef(defaults);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setSettings({ ...defaultsRef.current, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const update = useCallback(
    (patch: Partial<T>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  return [settings, update];
}
