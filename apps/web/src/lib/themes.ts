import type { ThemeDefinition } from "@plan/shared/lib/themes";
import pierreDarkSoft from "@plan/shared/themes/pierre-dark-soft.json";
import softDark from "@plan/shared/themes/soft-dark.json";
import softLight from "@plan/shared/themes/soft-light.json";

/**
 * The themes, enumerated. Unlike the desktop app (which auto-discovers them via
 * Vite's `import.meta.glob`), Next has no glob, so new files under
 * `shared/themes/` must be added here too to appear on the web.
 */
export const THEMES: ThemeDefinition[] = [
  softLight as ThemeDefinition,
  softDark as ThemeDefinition,
  pierreDarkSoft as ThemeDefinition,
];
