import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { relative, sep, isAbsolute, join } from "path";
import chokidar, { type FSWatcher } from "chokidar";
import ignore, { type Ignore } from "ignore";
import { resolveProjectCwd } from "./claude-projects";
import { IGNORED_DIRS } from "./ignored-dirs";

const execFileP = promisify(execFile);

/**
 * Watches a project's actual git worktree (the real repo on disk) so the UI
 * reflects file/git changes made OUTSIDE the app — terminal commands, agent
 * edits, `git add/commit/push` — without the user having to refresh.
 *
 * This is separate from session-watcher.ts, which only watches the Claude
 * session `.jsonl` files under ~/.claude/projects. Here we watch the working
 * tree itself plus the few `.git` files that signal a stage/commit/checkout.
 *
 * Emits a single debounced `worktree-changed` event per encoded project; the
 * renderer re-pulls git status/diff and bumps the per-project content revision
 * so open file/diff/image panes re-fetch.
 */

const DEBOUNCE_MS = 200;

export interface WorktreeEvent {
  kind: "worktree-changed";
  encoded: string;
}

export interface WorktreeWatcherCallbacks {
  onEvent: (e: WorktreeEvent) => void;
}

let callbacks: WorktreeWatcherCallbacks | null = null;

export function setWorktreeCallbacks(cb: WorktreeWatcherCallbacks) {
  callbacks = cb;
}

interface ActiveWatch {
  watcher: FSWatcher;
  debounce: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, ActiveWatch>();

// Directories we never want to watch — they generate enormous event storms and
// are virtually always git-ignored anyway. Critically, when the opened folder
// is a *container* of several nested git repos, the parent's `.gitignore` (if
// any) doesn't cover the nested repos' build/dependency trees, so this fixed
// set is the only thing stopping chokidar from recursively walking and watching
// every `target`/`vendor`/`venv`/`Pods`/… across all of them. We share the file
// finder's comprehensive list ({@link ./ignored-dirs.ts}) so the two can't drift.
// `.git` is in the set; the real git dir is still reached because the git-dir
// branch in `ignored` below is checked first and returns before this prune.
const ALWAYS_IGNORE_DIRS = IGNORED_DIRS;

// Within a git dir, only these signal something the UI cares about (staging,
// commits, branch switches, fetched/pushed refs). Everything else — objects,
// packs, etc. — is noise we must prune or a commit floods us with events.
function gitPathIsRelevant(rel: string): boolean {
  const top = rel.split(sep)[0];
  return (
    rel === "index" ||
    rel === "HEAD" ||
    rel === "ORIG_HEAD" ||
    rel === "MERGE_HEAD" ||
    top === "refs" ||
    top === "logs"
  );
}

function isInside(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir + sep);
}

/**
 * Resolve the absolute git dir(s) for a worktree. For a linked worktree the
 * per-worktree git dir (index/HEAD live here) differs from the common dir
 * (shared refs/objects), so we may watch both.
 */
async function resolveGitDirs(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "rev-parse", "--absolute-git-dir", "--git-common-dir"],
      { timeout: 5000 },
    );
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (isAbsolute(l) ? l : join(cwd, l)));
    return [...new Set(lines)];
  } catch {
    return [];
  }
}

async function loadGitignore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const body = await readFile(join(cwd, ".gitignore"), "utf-8");
    ig.add(body);
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

export async function startWorktreeWatch(encoded: string): Promise<void> {
  if (watchers.has(encoded)) return;
  // Claim the slot synchronously so concurrent calls don't both build watchers.
  const slot: ActiveWatch = {
    watcher: null as unknown as FSWatcher,
    debounce: null,
  };
  watchers.set(encoded, slot);

  let cwd: string;
  try {
    cwd = await resolveProjectCwd(encoded);
  } catch {
    watchers.delete(encoded);
    return;
  }

  const gitDirs = await resolveGitDirs(cwd);
  const ig = await loadGitignore(cwd);

  // If the watch was torn down while we resolved paths, abort.
  if (watchers.get(encoded) !== slot) return;

  const ignored = (p: string): boolean => {
    const gd = gitDirs.find((d) => isInside(d, p));
    if (gd) {
      const rel = relative(gd, p);
      // The git dir root (and the refs/ , logs/ subtrees) must NOT be ignored,
      // or chokidar won't descend to reach the index/HEAD/ref files inside.
      if (rel === "") return false;
      return !gitPathIsRelevant(rel);
    }

    const rel = relative(cwd, p);
    if (rel === "") return false;
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    if (parts.some((seg) => ALWAYS_IGNORE_DIRS.has(seg))) return true;
    try {
      if (ig.ignores(rel)) return true;
    } catch {
      // ignore throws on odd paths — don't let it kill the watcher
    }
    return false;
  };

  // Watch the worktree root plus any git dirs that live outside it (linked
  // worktrees). For a normal repo the git dir is under cwd and already covered.
  const roots = [cwd, ...gitDirs.filter((d) => !isInside(cwd, d))];

  const watcher = chokidar.watch(roots, {
    ignored,
    ignoreInitial: true, // we only care about changes after we start
    persistent: true,
    followSymlinks: false,
  });
  slot.watcher = watcher;

  const schedule = () => {
    if (slot.debounce) clearTimeout(slot.debounce);
    slot.debounce = setTimeout(() => {
      slot.debounce = null;
      callbacks?.onEvent({ kind: "worktree-changed", encoded });
    }, DEBOUNCE_MS);
  };

  watcher.on("all", schedule);
  // A watcher error (e.g. transient EMFILE) shouldn't take the process down.
  watcher.on("error", () => {});
}

export function stopWorktreeWatch(encoded: string): void {
  const a = watchers.get(encoded);
  if (!a) return;
  watchers.delete(encoded);
  if (a.debounce) clearTimeout(a.debounce);
  void a.watcher?.close();
}

export function stopAllWorktreeWatches(): void {
  for (const enc of [...watchers.keys()]) stopWorktreeWatch(enc);
}
