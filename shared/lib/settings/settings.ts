"use client";

import { usePersistedSettings } from "./use-persisted-settings";

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
  return usePersistedSettings(STORAGE_KEY, DEFAULTS);
}
