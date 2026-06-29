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
