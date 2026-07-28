import { watch, type FSWatcher } from "fs";
import { readFile } from "fs/promises";
import { relative, sep, isAbsolute, join } from "path";
import ignore, { type Ignore } from "ignore";
import { git } from "./git-exec";
import { resolveProjectCwd } from "./providers/claude-code/projects";
import { IGNORED_DIRS } from "./ignored-dirs";

/**
 * Watches a project's actual git worktree (the real repo on disk) so the UI
 * reflects file/git changes made OUTSIDE the app — terminal commands, agent
 * edits, `git add/commit/push` — without the user having to refresh.
 *
 * This is separate from session-watcher.ts, which only watches the Claude
 * session `.jsonl` files under ~/.claude/projects. Here we watch the working
 * tree itself plus the few `.git` files that signal a stage/commit/checkout.
 *
 * Backend: native recursive `fs.watch` — on macOS that is ONE FSEvents stream
 * per watch root, O(1) file descriptors regardless of tree size. This used to
 * be chokidar v4, which (having dropped fsevents) watches each file via
 * kqueue, holding an OPEN FD PER WATCHED FILE: a big worktree pinned the main
 * process at its ~10k fd limit, and at that ceiling every new pty and renderer
 * spawn failed with EMFILE (terminals died instantly, DevTools couldn't open).
 * FSEvents doesn't walk the tree, so there is no watch-time pruning; filtering
 * happens per EVENT via `ignored` below instead.
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
  /** One recursive watcher per root (worktree + any external git dirs). */
  watchers: FSWatcher[];
  debounce: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, ActiveWatch>();

// Directories whose events we always drop — build/dependency churn (a `pnpm
// install`, a bundler writing `dist`) would otherwise re-fire the debounced
// refresh continuously, and they are virtually always git-ignored anyway.
// Critically, when the opened folder is a *container* of several nested git
// repos, the parent's `.gitignore` (if any) doesn't cover the nested repos'
// build/dependency trees, so this fixed set is the only thing keeping their
// churn out. We share the file finder's comprehensive list
// ({@link ./ignored-dirs.ts}) so the two can't drift. `.git` is in the set;
// events from the real git dir still get through because the git-dir branch in
// `ignored` below is checked first and returns before this name check.
const ALWAYS_IGNORE_DIRS = IGNORED_DIRS;

// Within a git dir, only these signal something the UI cares about (staging,
// commits, branch switches, fetched/pushed refs). Everything else — objects,
// packs, etc. — is noise we must drop or a commit floods us with events.
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
  const r = await git(
    cwd,
    ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    { timeoutMs: 5000 },
  );
  if (r.code !== 0) return [];
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (isAbsolute(l) ? l : join(cwd, l)));
  return [...new Set(lines)];
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
  const slot: ActiveWatch = { watchers: [], debounce: null };
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
      // The git dir root itself (a null-filename event) and the index/HEAD/ref
      // paths inside it must NOT be ignored — those are the git events the UI
      // exists to catch.
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

  const schedule = () => {
    if (slot.debounce) clearTimeout(slot.debounce);
    slot.debounce = setTimeout(() => {
      slot.debounce = null;
      callbacks?.onEvent({ kind: "worktree-changed", encoded });
    }, DEBOUNCE_MS);
  };

  for (const root of roots) {
    let w: FSWatcher;
    try {
      // Callback-style fs.watch, NOT the fs/promises async iterator: the
      // iterator buffers events into a bounded queue that a dependency-install
      // storm could overflow (killing the loop); the callback form has no
      // queue, and this handler is a cheap string check + debounce re-arm.
      w = watch(root, { recursive: true }, (_event, filename) => {
        // Paths arrive relative to the watched root. A null filename (rare,
        // platform-dependent) means "something changed" — refresh
        // conservatively rather than guess at what.
        if (filename && ignored(join(root, filename.toString()))) return;
        schedule();
      });
    } catch {
      // Root vanished between resolve and watch — skip it.
      continue;
    }
    // A watcher error (e.g. the root being deleted mid-watch) must not take
    // the process down; the next startWorktreeWatch rebuilds cleanly.
    w.on("error", () => {});
    slot.watchers.push(w);
  }
}

export function stopWorktreeWatch(encoded: string): void {
  const a = watchers.get(encoded);
  if (!a) return;
  watchers.delete(encoded);
  if (a.debounce) clearTimeout(a.debounce);
  for (const w of a.watchers) w.close();
}

export function stopAllWorktreeWatches(): void {
  for (const enc of [...watchers.keys()]) stopWorktreeWatch(enc);
}
