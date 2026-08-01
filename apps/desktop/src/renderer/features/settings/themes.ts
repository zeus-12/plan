import type { ThemeDefinition } from "@plan/shared/lib/themes";

/**
 * Auto-discover every theme JSON under `shared/themes/`. Dropping a new file
 * there adds a theme — no code change needed (the same `import.meta.glob`
 * pattern we use for file icons). Sorted by id for a stable picker order.
 */
const modules = import.meta.glob("../../../../../../shared/themes/*.json", {
  eager: true,
  import: "default",
}) as Record<string, ThemeDefinition>;

export const THEMES: ThemeDefinition[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, theme]) => theme);

if (THEMES.length === 0) {
  throw new Error("No themes found under shared/themes — theme glob is empty.");
}
