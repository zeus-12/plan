"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export const THEMES = [
  { id: "soft-dark", label: "Soft Dark", dark: true },
  { id: "soft-light", label: "Soft Light", dark: false },
  { id: "dark", label: "Contrast Dark", dark: true },
  { id: "light", label: "Contrast Light", dark: false },
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
    case "dark":
      return "light";
    case "light":
      return "dark";
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
