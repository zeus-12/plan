import { useLayoutEffect } from "react";
import { createPersistedValue } from "@/renderer/lib/external-value";

/**
 * Reading preferences for rendered-markdown prose (the chat transcript and PR
 * conversation): which font it's set in, its size, and how bright the text is
 * against the dark chat background. Persisted to localStorage and applied as
 * CSS variables on <html>, which the shared Markdown root consumes — so the
 * choice follows the reader across every transcript without prop-drilling.
 */

export type ProseFontId = "inter" | "system" | "charter" | "georgia" | "mono";
export type ProseBrightnessId = "normal" | "soft" | "softer";

export interface ProseFontOption {
  id: ProseFontId;
  label: string;
  /** Full font-family stack; system faces need no webfont load. */
  stack: string;
}

/** Reading faces offered in Settings (order = display order). */
export const PROSE_FONTS: ProseFontOption[] = [
  { id: "inter", label: "Inter", stack: '"Inter", system-ui, sans-serif' },
  {
    id: "system",
    label: "System (SF Pro)",
    stack: '-apple-system, system-ui, "SF Pro Text", sans-serif',
  },
  {
    id: "charter",
    label: "Charter (serif)",
    stack: 'Charter, "Iowan Old Style", Georgia, serif',
  },
  {
    id: "georgia",
    label: "Georgia (serif)",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: "mono",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  },
];

/** Selectable body sizes, in px. */
export const PROSE_SIZES = [13, 14, 15, 16] as const;

export interface ProseBrightnessOption {
  id: ProseBrightnessId;
  label: string;
  /** Percentage of `--text` kept; the remainder mixes toward `--bg`. 100 = as-is. */
  mix: number;
}

/**
 * Brightness is a mix of the theme's `--text` toward its `--bg`, so it stays
 * correct in every theme (dark *and* light) instead of hard-coding a colour.
 * "Soft" takes the halation edge off pure text-on-dark without dropping below
 * a comfortable reading contrast.
 */
export const PROSE_BRIGHTNESS: ProseBrightnessOption[] = [
  { id: "normal", label: "Normal", mix: 100 },
  { id: "soft", label: "Soft", mix: 86 },
  { id: "softer", label: "Softer", mix: 74 },
];

export interface TranscriptPrefs {
  fontFamily: ProseFontId;
  fontSize: number;
  brightness: ProseBrightnessId;
  /** Bionic reading: bold each word's leading letters in the chat transcript. */
  bionic: boolean;
}

const DEFAULTS: TranscriptPrefs = {
  fontFamily: "inter",
  fontSize: 14,
  brightness: "soft",
  bionic: false,
};

const store = createPersistedValue<TranscriptPrefs>(
  "plan.transcript",
  (raw) => {
    const r =
      raw && typeof raw === "object" ? (raw as Partial<TranscriptPrefs>) : {};
    return {
      fontFamily: PROSE_FONTS.some((f) => f.id === r.fontFamily)
        ? (r.fontFamily as ProseFontId)
        : DEFAULTS.fontFamily,
      fontSize: PROSE_SIZES.includes(r.fontSize as (typeof PROSE_SIZES)[number])
        ? (r.fontSize as number)
        : DEFAULTS.fontSize,
      brightness: PROSE_BRIGHTNESS.some((b) => b.id === r.brightness)
        ? (r.brightness as ProseBrightnessId)
        : DEFAULTS.brightness,
      bionic: typeof r.bionic === "boolean" ? r.bionic : DEFAULTS.bionic,
    };
  },
);

/** Push the current prefs onto <html> as the `--prose-*` variables. */
function applyTranscriptPrefs(p: TranscriptPrefs) {
  const el = document.documentElement;
  const font = PROSE_FONTS.find((f) => f.id === p.fontFamily) ?? PROSE_FONTS[0];
  const bright =
    PROSE_BRIGHTNESS.find((b) => b.id === p.brightness) ?? PROSE_BRIGHTNESS[0];
  el.style.setProperty("--prose-font", font.stack);
  el.style.setProperty("--prose-size", `${p.fontSize}px`);
  el.style.setProperty(
    "--prose-fg",
    bright.mix >= 100
      ? "var(--text)"
      : `color-mix(in srgb, var(--text) ${bright.mix}%, var(--bg))`,
  );
}

export function setTranscriptPrefs(patch: Partial<TranscriptPrefs>) {
  const next = { ...store.get(), ...patch };
  store.set(next);
  applyTranscriptPrefs(next);
}

/**
 * Flip bionic reading on/off. Bound to ⌘⇧B (App.tsx) and the Settings toggle.
 * Unlike font/size/brightness this isn't a `--prose-*` variable — it's read by
 * the chat renderer as a prop — so there's nothing to re-apply on <html>.
 */
export function toggleBionicReading() {
  setTranscriptPrefs({ bionic: !store.get().bionic });
}

/** React binding for the Settings UI. */
export function useTranscriptPrefs(): [
  TranscriptPrefs,
  (patch: Partial<TranscriptPrefs>) => void,
] {
  return [store.useValue(), setTranscriptPrefs];
}

/**
 * Mount once at the app root: applies the persisted prefs before first paint
 * (via layout effect, so there's no flash of the defaults) and keeps the CSS
 * variables in sync if the prefs change.
 */
export function useApplyTranscriptPrefs() {
  const prefs = store.useValue();
  useLayoutEffect(() => {
    applyTranscriptPrefs(prefs);
  }, [prefs]);
}
