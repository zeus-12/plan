"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { setActiveShikiTheme } from "../lib/shiki";

/**
 * UI themes. `shiki` is the syntax-highlight theme that ships with each — the
 * picker swaps both at once, so the user never selects a code theme separately.
 * The original four keep the default github pair; new themes carry their own.
 */
export const THEMES = [
  { id: "soft-dark", label: "Soft Dark", dark: true, shiki: "github-dark" },
  { id: "soft-light", label: "Soft Light", dark: false, shiki: "github-light" },
  {
    id: "pierre-dark-soft",
    label: "Pierre Dark Soft",
    dark: true,
    shiki: "pierre-dark-soft",
  },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

function isTheme(v: string | null): v is Theme {
  return THEMES.some((t) => t.id === v);
}

function themeIsDark(t: Theme): boolean {
  return THEMES.find((x) => x.id === t)?.dark ?? false;
}

/**
 * Themes are CSS-var sets in globals.css. `dark` carries the high-contrast
 * dark vars AND the is-dark signal other code keys off (e.g. xterm fallbacks),
 * so soft-dark applies both `dark` and its own override class.
 */
function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.classList.toggle("dark", themeIsDark(t));
  el.classList.toggle("theme-soft-dark", t === "soft-dark");
  el.classList.toggle("theme-soft-light", t === "soft-light");
  el.classList.toggle("theme-pierre-dark-soft", t === "pierre-dark-soft");
  // Keep syntax highlighting in lockstep with the UI theme.
  setActiveShikiTheme(THEMES.find((x) => x.id === t)?.shiki ?? "github-dark");
}

const STORAGE_KEY = "plan-theme-v2";
/** Pre-themes key — its light/dark value seeds the matching soft variant. */
const LEGACY_KEY = "plan-theme";

const ThemeContext = createContext<{
  theme: Theme;
  isDark: boolean;
  setTheme: (t: Theme) => void;
  /** Flip dark-ness, staying within the soft / high-contrast family. */
  toggle: () => void;
}>({
  theme: "soft-light",
  isDark: false,
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function flip(t: Theme): Theme {
  switch (t) {
    case "soft-dark":
      return "soft-light";
    case "soft-light":
      return "soft-dark";
    // Pierre is dark-only; flip to the nearest light theme.
    case "pierre-dark-soft":
      return "soft-light";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("soft-light");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    let initial: Theme;
    if (isTheme(stored)) {
      initial = stored;
    } else {
      const legacy = localStorage.getItem(LEGACY_KEY);
      const dark =
        legacy !== null
          ? legacy === "dark"
          : window.matchMedia("(prefers-color-scheme: dark)").matches;
      initial = dark ? "soft-dark" : "soft-light";
    }
    setThemeState(initial);
    applyTheme(initial);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next = flip(prev);
      localStorage.setItem(STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider
      value={{ theme, isDark: themeIsDark(theme), setTheme, toggle }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
