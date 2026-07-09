/**
 * Directory names we never descend into — VCS internals plus the heavy,
 * generated, or dependency dirs that bloat a recursive walk without ever being
 * something the UI cares about. Matched by exact name at any depth.
 *
 * Shared by the file finder ({@link ./project-files.ts}) and the worktree
 * watcher ({@link ./worktree-watcher.ts}) so the two can't drift apart: when a
 * project folder is a *container* of several nested git repos, the watcher must
 * prune each nested repo's build/dependency trees (`target`, `vendor`, `venv`,
 * `Pods`, `DerivedData`, …) or chokidar recursively walks and watches hundreds
 * of thousands of files and beachballs the app.
 *
 * Fixed list on purpose: predictable, fast, and identical with or without git
 * (no `.gitignore` parsing, no `git` subprocess).
 */
export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".pnpm",
  ".yarn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".svelte-kit",
  ".parcel-cache",
  ".vite",
  "coverage",
  ".nyc_output",
  "target",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode-test",
  "vendor",
  "Pods",
  "Carthage",
  "DerivedData",
  ".terraform",
  ".cache",
  "tmp",
]);

/**
 * File names we never surface in the Files tab, ⌘P finder, `@`-mentions, or
 * search — OS/editor junk that's noise in a file list and never something the
 * user opens (macOS `.DS_Store`, Windows `Thumbs.db`/`Desktop.ini`). Matched by
 * exact name at any depth, mirroring {@link IGNORED_DIRS}. This is the same set
 * an editor like VS Code hides by default via its `files.exclude` setting.
 */
export const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
