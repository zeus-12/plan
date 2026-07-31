import { watch, type FSWatcher } from "fs";
import { readFile } from "fs/promises";
import { relative, sep, isAbsolute, join } from "path";
import ignore, { type Ignore } from "ignore";
import { git } from "./git-exec";
import { repoLayout, type RepoLocation } from "./git";
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
 * Those git dirs are resolved PER REPO (see resolveGitDirs) — in a worktree or
 * any multi-repo project they live outside the project root, so a root-only
 * resolution watched none of them and staging was invisible to the UI.
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
// Ceiling on how long a burst can postpone the refresh. The debounce above is
// trailing-only, so an agent writing files back-to-back (or a `git gc` churning
// `.git/objects`) re-arms it forever and the UI never updates until things go
// quiet. Past this many ms since the burst's FIRST event we fire regardless.
const MAX_DEBOUNCE_MS = 800;
// FSEvents streams are cheap (one shared thread, no per-file fd) but not free,
// and a project's roots come from repo discovery, which we don't control. Cap
// them and say out loud what didn't get watched.
const MAX_WATCH_ROOTS = 24;

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
  /** When the current burst started — drives the MAX_DEBOUNCE_MS ceiling. */
  burstStart: number | null;
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
 * Absolute git dir(s) for ONE repo. For a linked worktree the per-worktree git
 * dir (index/HEAD live here) differs from the common dir (shared refs), so both
 * come back and both get watched.
 */
async function gitDirsFor(repoPath: string): Promise<string[]> {
  const r = await git(
    repoPath,
    ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
    { timeoutMs: 5000 },
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (isAbsolute(l) ? l : join(repoPath, l)));
}

/**
 * Git dirs to watch, resolved PER REPO rather than at the project root. This is
 * the whole reason staging shows up promptly: in a plan worktree (and in any
 * project whose root is a container of repos) the root is not itself a repo, so
 * a root-only `rev-parse` fails and we'd watch no git dir at all — while the
 * repo's real index sits in `<source-repo>/.git/worktrees/<name>/`, outside the
 * watched tree. `git add` / `commit` / `checkout` then fire NO event and the
 * Diffs tab stays stale until an unrelated file write happens to wake it.
 */
async function resolveGitDirs(
  cwd: string,
  repos: RepoLocation[],
): Promise<string[]> {
  const paths = repos.length > 0 ? repos.map((r) => r.path) : [cwd];
  const lists = await Promise.all(paths.map(gitDirsFor));
  return [...new Set(lists.flat())];
}

/** A directory whose `.gitignore` governs the paths beneath it. */
interface IgnoreBase {
  dir: string;
  ig: Ignore;
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

/** Per-repo ignore rules, most specific first — a nested repo's `.gitignore`
 *  must be applied relative to that repo, not to the project root. */
async function loadIgnores(dirs: string[]): Promise<IgnoreBase[]> {
  const bases = await Promise.all(
    dirs.map(async (dir) => ({ dir, ig: await loadGitignore(dir) })),
  );
  return bases.sort((a, b) => b.dir.length - a.dir.length);
}

export async function startWorktreeWatch(encoded: string): Promise<void> {
  if (watchers.has(encoded)) return;
  // Claim the slot synchronously so concurrent calls don't both build watchers.
  const slot: ActiveWatch = { watchers: [], debounce: null, burstStart: null };
  watchers.set(encoded, slot);

  let cwd: string;
  try {
    cwd = await resolveProjectCwd(encoded);
  } catch {
    watchers.delete(encoded);
    return;
  }

  const repos = await repoLayout(encoded).catch(() => [] as RepoLocation[]);
  const gitDirs = await resolveGitDirs(cwd, repos);
  const ignores = await loadIgnores([
    cwd,
    ...repos.map((r) => r.path).filter((p) => p !== cwd),
  ]);

  // If the watch was torn down while we resolved paths, abort.
  if (watchers.get(encoded) !== slot) return;

  // Longest first, so a path resolves against the most specific git dir. A
  // linked worktree's git dir sits INSIDE the common dir: matched against the
  // common dir, its `index` reads as `worktrees/<name>/index`, which fails the
  // relevance test and would drop every staging event.
  const matchGitDirs = [...gitDirs].sort((a, b) => b.length - a.length);

  const ignored = (p: string): boolean => {
    const gd = matchGitDirs.find((d) => isInside(d, p));
    if (gd) {
      const rel = relative(gd, p);
      // The git dir root itself (a null-filename event) and the index/HEAD/ref
      // paths inside it must NOT be ignored — those are the git events the UI
      // exists to catch.
      if (rel === "") return false;
      return !gitPathIsRelevant(rel);
    }

    const base = ignores.find((b) => isInside(b.dir, p));
    if (!base) return false;
    const rel = relative(base.dir, p);
    if (rel === "") return false;
    const parts = rel.split(sep);
    if (parts.some((seg) => ALWAYS_IGNORE_DIRS.has(seg))) return true;
    try {
      if (base.ig.ignores(rel)) return true;
    } catch {
      // ignore throws on odd paths — don't let it kill the watcher
    }
    return false;
  };

  // The worktree root plus every git dir that isn't already inside a root a
  // recursive watch covers (a plain single-repo project keeps exactly one
  // stream, as before).
  // Shortest first so a parent absorbs its children — a linked worktree's git
  // dir lives inside the common dir, and watching both would double every
  // event for one stream's worth of coverage.
  const orderedGitDirs = [...gitDirs].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const dir of [cwd, ...orderedGitDirs]) {
    if (roots.some((r) => isInside(r, dir))) continue;
    if (roots.length >= MAX_WATCH_ROOTS) {
      console.warn(
        `[worktree-watcher] ${encoded}: at the ${MAX_WATCH_ROOTS}-root cap, not watching ${dir}`,
      );
      continue;
    }
    roots.push(dir);
  }

  const schedule = () => {
    const now = Date.now();
    if (slot.burstStart === null) slot.burstStart = now;
    if (slot.debounce) clearTimeout(slot.debounce);
    const wait = Math.max(
      0,
      Math.min(DEBOUNCE_MS, slot.burstStart + MAX_DEBOUNCE_MS - now),
    );
    slot.debounce = setTimeout(() => {
      slot.debounce = null;
      slot.burstStart = null;
      callbacks?.onEvent({ kind: "worktree-changed", encoded });
    }, wait);
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

/**
 * Rebuild an active watch. Roots are resolved once at start from the repo
 * layout, so a project that gains a repo (a checkout added to a worktree) would
 * otherwise never watch the new repo's git dir.
 */
export async function restartWorktreeWatch(encoded: string): Promise<void> {
  if (!watchers.has(encoded)) return;
  stopWorktreeWatch(encoded);
  await startWorktreeWatch(encoded);
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
