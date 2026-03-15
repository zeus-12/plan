"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "plan-settings";

export const FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16] as const;
export type FontSize = (typeof FONT_SIZE_OPTIONS)[number];

export interface DiffSettings {
  viewMode: "split" | "unified";
  hideUnchanged: boolean;
  fontSize: FontSize;
  lineWrap: boolean;
  ignoreWhitespace: boolean;
}

const DEFAULTS: DiffSettings = {
  viewMode: "split",
  hideUnchanged: true,
  fontSize: 13,
  lineWrap: false,
  ignoreWhitespace: false,
};

export function useDiffSettings(): [
  DiffSettings,
  (patch: Partial<DiffSettings>) => void,
] {
  const [settings, setSettings] = useState<DiffSettings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, []);

  const update = useCallback((patch: Partial<DiffSettings>) => {
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
