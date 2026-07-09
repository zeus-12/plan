"use client";

import { type FontSize } from "./settings";
import { usePersistedSettings } from "./use-persisted-settings";

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
  return usePersistedSettings(STORAGE_KEY, DEFAULTS);
}
