import type { ThemeDefinition } from "@plan/shared/lib/themes";
import pierreDark from "@plan/shared/themes/pierre-dark.json";
import pierreDarkSoft from "@plan/shared/themes/pierre-dark-soft.json";
import softLight from "@plan/shared/themes/soft-light.json";
import vitesseBlack from "@plan/shared/themes/vitesse-black.json";
import vitesseDark from "@plan/shared/themes/vitesse-dark.json";

/**
 * The themes, enumerated. Unlike the desktop app (which auto-discovers them via
 * Vite's `import.meta.glob`), Next has no glob, so new files under
 * `shared/themes/` must be added here too to appear on the web. Listed in the
 * same filename order the glob yields, so both apps agree on which dark theme
 * a dark-preferring visitor lands on.
 */
export const THEMES: ThemeDefinition[] = [
  pierreDarkSoft as ThemeDefinition,
  pierreDark as ThemeDefinition,
  softLight as ThemeDefinition,
  vitesseBlack as ThemeDefinition,
  vitesseDark as ThemeDefinition,
];
