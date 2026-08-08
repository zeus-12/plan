/**
 * Data-driven theme model. Every theme is a self-contained JSON file under
 * `shared/themes/` shaped like {@link ThemeDefinition}. Adding a file there adds
 * a theme — there is no per-theme code, CSS, or name list anywhere else.
 *
 * The desktop app auto-discovers the files via Vite's `import.meta.glob`; the
 * web app enumerates them (Next has no glob). Both feed the resulting array
 * into `<ThemeProvider themes={…}>`, which injects the colors as CSS variables
 * and registers the syntax themes at runtime.
 */

/** CSS custom properties a theme sets, keyed WITHOUT the leading `--`. */
export type ThemeColors = Record<string, string>;

/**
 * The embedded terminal's ANSI palette. Keys map to xterm's `ITheme` colors
 * (kebab-cased: `bright-black` → `brightBlack`) and are injected as `--term-*`
 * CSS variables, so `terminal-panel` reads them the same way it reads `colors`.
 * Every key is optional — a theme that omits the block (or any entry) falls back
 * to the component's built-in defaults. The full set is: black, red, green,
 * yellow, blue, magenta, cyan, white and their `bright-*` variants.
 */
export type TerminalColors = Record<string, string>;

/** A full VS Code / shiki theme object. Its `name` is the id shiki uses. */
export interface ShikiThemeJson {
  name: string;
  [key: string]: unknown;
}

/**
 * Picker sections, in display order. Themes are bucketed by how deep their
 * background sits so neighbouring entries in the list look alike; `light` is
 * last because it's the one people reach for least.
 */
export const THEME_GROUPS = [
  { id: "dark", label: "Dark" },
  { id: "darker", label: "Darker" },
  { id: "light", label: "Light" },
] as const;

export type ThemeGroupId = (typeof THEME_GROUPS)[number]["id"];

export interface ThemeDefinition {
  /** Stable id; also the persisted value and the `theme-<id>` body class. */
  id: string;
  /** User-facing name shown in the picker. */
  label: string;
  /** Whether the `dark` class applies (Tailwind dark variant, xterm fallback). */
  dark: boolean;
  /** Color tokens → injected as `--<key>` CSS variables. */
  colors: ThemeColors;
  /** Terminal ANSI palette → injected as `--term-<key>` CSS variables. */
  terminal?: TerminalColors;
  /**
   * Syntax highlighting: either a bundled shiki theme name ("github-dark") or a
   * full VS Code theme JSON object whose `name` field is the shiki id.
   */
  syntax: string | ShikiThemeJson;
  /**
   * Theme id the light/dark toggle switches to. Optional — without it the
   * toggle falls back to the first theme of opposite darkness.
   */
  toggleTo?: string;
  /**
   * Which picker section the theme is listed under. Omitting it files the theme
   * by `dark` alone, so a new JSON still lands somewhere sensible.
   */
  group?: ThemeGroupId;
}

/** The shiki theme id a definition tokenizes with. */
export function shikiNameFor(t: ThemeDefinition): string {
  return typeof t.syntax === "string" ? t.syntax : t.syntax.name;
}

/** The preview swatch is simply the theme's background. */
export function swatchFor(t: ThemeDefinition): string {
  return t.colors.bg ?? "transparent";
}

export interface ThemeGroup {
  id: ThemeGroupId;
  label: string;
  themes: ThemeDefinition[];
}

/**
 * Split themes into {@link THEME_GROUPS} order for the picker, keeping the
 * caller's ordering within each section and dropping sections nothing fell in.
 */
export function groupThemes(themes: ThemeDefinition[]): ThemeGroup[] {
  return THEME_GROUPS.map(({ id, label }) => ({
    id,
    label,
    themes: themes.filter(
      (t) => (t.group ?? (t.dark ? "dark" : "light")) === id,
    ),
  })).filter((g) => g.themes.length > 0);
}

/**
 * Build a stylesheet exposing every theme's tokens as CSS variables, scoped to
 * `.theme-<id>`. The first light theme (or first theme) also seeds `:root` so
 * colors exist before a theme class is applied — avoiding an unstyled flash on
 * the very first paint.
 */
export function buildThemeStylesheet(themes: ThemeDefinition[]): string {
  const declarations = (t: ThemeDefinition) =>
    [
      ...Object.entries(t.colors).map(([k, v]) => `  --${k}: ${v};`),
      ...Object.entries(t.terminal ?? {}).map(
        ([k, v]) => `  --term-${k}: ${v};`,
      ),
    ].join("\n");
  const rule = (selector: string, t: ThemeDefinition) =>
    `${selector} {\n${declarations(t)}\n}`;

  const blocks = themes.map((t) => rule(`.theme-${t.id}`, t));
  const seed = themes.find((t) => !t.dark) ?? themes[0];
  if (seed) blocks.unshift(rule(":root", seed));
  return blocks.join("\n\n");
}

/**
 * The theme the light/dark toggle should switch to: explicit `toggleTo` when
 * set, otherwise the first theme of opposite darkness, otherwise stay put.
 */
export function toggleTarget(
  themes: ThemeDefinition[],
  current: ThemeDefinition,
): ThemeDefinition {
  if (current.toggleTo) {
    const explicit = themes.find((t) => t.id === current.toggleTo);
    if (explicit) return explicit;
  }
  return themes.find((t) => t.dark !== current.dark) ?? current;
}
