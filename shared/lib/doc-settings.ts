"use client";

import { useCallback, useEffect, useState } from "react";
import { type FontSize } from "./settings";

const STORAGE_KEY = "plan-doc-settings";

/**
 * View preferences for the read-only doc surface. Kept separate from the diff's
 * settings so toggling wrap/size on a doc doesn't reach across and change the
 * diff tool. Docs read better wrapped, so `lineWrap` defaults on.
 */
export interface DocSettings {
  fontSize: FontSize;
  lineWrap: boolean;
}

const DEFAULTS: DocSettings = {
  fontSize: 13,
  lineWrap: true,
};

export function useDocSettings(): [
  DocSettings,
  (patch: Partial<DocSettings>) => void,
] {
  const [settings, setSettings] = useState<DocSettings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, []);

  const update = useCallback((patch: Partial<DocSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return [settings, update];
}
