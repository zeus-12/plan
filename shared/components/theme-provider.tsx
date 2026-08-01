"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ensureHighlighter,
  registerShikiThemes,
  setActiveShikiTheme,
} from "../lib/syntax/shiki";
import {
  buildThemeStylesheet,
  shikiNameFor,
  toggleTarget,
  type ThemeDefinition,
} from "../lib/themes";

const STORAGE_KEY = "plan-theme-v2";
/** Pre-themes key — its light/dark value seeds the matching variant. */
const LEGACY_KEY = "plan-theme";
/** The <style> element our generated CSS variables live in. */
const STYLE_ID = "plan-theme-vars";

interface ThemeContextValue {
  /** Active theme id. */
  theme: string;
  isDark: boolean;
  /** All available themes (data-driven, supplied by the app). */
  themes: ThemeDefinition[];
  setTheme: (id: string) => void;
  /** Flip dark-ness, following each theme's `toggleTo` (or nearest opposite). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "",
  isDark: false,
  themes: [],
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

/** A non-dark theme is the SSR-safe default (no localStorage on the server). */
function defaultThemeId(themes: ThemeDefinition[]): string {
  return (themes.find((t) => !t.dark) ?? themes[0])?.id ?? "";
}

export function ThemeProvider({
  themes,
  children,
}: {
  themes: ThemeDefinition[];
  children: React.ReactNode;
}) {
  const byId = useMemo(() => new Map(themes.map((t) => [t.id, t])), [themes]);
  // Generated once and rendered inline (below) so the variables are present on
  // the very first paint and in SSR output — no flash of unstyled content.
  const styleSheet = useMemo(() => buildThemeStylesheet(themes), [themes]);

  // Register syntax themes during render (before any child's mount effect can
  // ask shiki to tokenize) so a theme's bundled/custom syntax is always known.
  registerShikiThemes(themes);

  const [theme, setThemeState] = useState<string>(() => defaultThemeId(themes));

  const applyTheme = useCallback(
    (id: string) => {
      const t = byId.get(id);
      const el = document.documentElement;
      for (const x of themes) el.classList.remove(`theme-${x.id}`);
      if (id) el.classList.add(`theme-${id}`);
      // `dark` carries the is-dark signal other code keys off (Tailwind's dark
      // variant, xterm fallbacks) — not the colors, which the theme class owns.
      el.classList.toggle("dark", !!t?.dark);
      // Keep syntax highlighting in lockstep with the UI theme.
      setActiveShikiTheme(t ? shikiNameFor(t) : "github-dark");
    },
    [byId, themes],
  );

  // Resolve the persisted/preferred theme and apply its class. Runs client-side
  // only; the inline <style> below already supplies the variables, and the
  // default theme's `:root` seed covers the pre-effect paint.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    let initial: string;
    if (stored && byId.has(stored)) {
      initial = stored;
    } else {
      const legacy = localStorage.getItem(LEGACY_KEY);
      const wantDark =
        legacy !== null
          ? legacy === "dark"
          : window.matchMedia("(prefers-color-scheme: dark)").matches;
      initial =
        (themes.find((t) => t.dark === wantDark) ?? themes[0])?.id ?? "";
    }
    setThemeState(initial);
    applyTheme(initial);
  }, [themes, byId, applyTheme]);

  // Warm the syntax highlighter at startup. `registerShikiThemes` above has
  // already run during this render, so the highlighter loads with every theme's
  // grammar/syntax. Kicking it off now (during idle startup) means the first
  // file or diff a user opens is colored on first paint — instead of flashing
  // plain text while shiki's WASM + grammars load on demand.
  useEffect(() => {
    void ensureHighlighter();
  }, []);

  const setTheme = useCallback(
    (id: string) => {
      setThemeState(id);
      localStorage.setItem(STORAGE_KEY, id);
      applyTheme(id);
    },
    [applyTheme],
  );

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const current = byId.get(prev) ?? themes[0];
      if (!current) return prev;
      const next = toggleTarget(themes, current).id;
      localStorage.setItem(STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, [byId, themes, applyTheme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        isDark: !!byId.get(theme)?.dark,
        themes,
        setTheme,
        toggle,
      }}
    >
      <style id={STYLE_ID} dangerouslySetInnerHTML={{ __html: styleSheet }} />
      {children}
    </ThemeContext.Provider>
  );
}
