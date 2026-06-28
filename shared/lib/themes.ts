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

/** A full VS Code / shiki theme object. Its `name` is the id shiki uses. */
export interface ShikiThemeJson {
  name: string;
  [key: string]: unknown;
}

export interface ThemeDefinition {
  /** Stable id; also the persisted value and the `theme-<id>` body class. */
  id: string;
  /** User-facing name shown in the picker. */
  label: string;
  /** Whether the `dark` class applies (Tailwind dark variant, xterm fallback). */
  dark: boolean;
  /** Color tokens → injected as `--<key>` CSS variables. */
  colors: ThemeColors;
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
}

/** The shiki theme id a definition tokenizes with. */
export function shikiNameFor(t: ThemeDefinition): string {
  return typeof t.syntax === "string" ? t.syntax : t.syntax.name;
}

/** The preview swatch is simply the theme's background. */
export function swatchFor(t: ThemeDefinition): string {
  return t.colors.bg ?? "transparent";
}

/**
 * Build a stylesheet exposing every theme's tokens as CSS variables, scoped to
 * `.theme-<id>`. The first light theme (or first theme) also seeds `:root` so
 * colors exist before a theme class is applied — avoiding an unstyled flash on
 * the very first paint.
 */
export function buildThemeStylesheet(themes: ThemeDefinition[]): string {
  const rule = (selector: string, colors: ThemeColors) =>
    `${selector} {\n${Object.entries(colors)
      .map(([key, value]) => `  --${key}: ${value};`)
      .join("\n")}\n}`;

  const blocks = themes.map((t) => rule(`.theme-${t.id}`, t.colors));
  const seed = themes.find((t) => !t.dark) ?? themes[0];
  if (seed) blocks.unshift(rule(":root", seed.colors));
  return blocks.join("\n\n");
}

/**
 * The theme the light/dark toggle should switch to: explicit `toggleTo` when
 * set, otherwise the first theme of opposite darkness, otherwise stay put.
 */
export function toggleTarget(
  themes: ThemeDefinition[],
  current: ThemeDefinition
): ThemeDefinition {
  if (current.toggleTo) {
    const explicit = themes.find((t) => t.id === current.toggleTo);
    if (explicit) return explicit;
  }
  return themes.find((t) => t.dark !== current.dark) ?? current;
}
