# Handoff: Command+P / project file listing

> Standalone explainer for a fresh agent. No code changes implied — context only.

## What it is
`listProjectFiles(encoded)` in `apps/desktop/src/main/project-files.ts` returns the
project's flat list of relative file paths. It powers four surfaces:

- **⌘P quick-open** (Fuse fuzzy match) and the **Files-tab tree** —
  `renderer/components/project-workspace.tsx` holds `projectFiles` state, passed to
  `middle-sidebar.tsx` → `project-file-list.tsx`. Fetched via IPC `files:list`
  (`main/index.ts:561`) → preload `listProjectFiles` (`preload/index.ts`).
- **Project-wide Search tab** — `searchProjectFiles` calls the same `fileList`.
- **Chat `@file` mentions** — `renderer/components/mention-data.ts`.

## How it lists files (`fileList` in project-files.ts)
1. Runs `git ls-files --cached --others --exclude-standard` → tracked + untracked
   files that aren't gitignored (respects `.gitignore` for free).
2. Also runs `git ls-files --deleted` and subtracts it, so files deleted on disk
   but whose deletion isn't staged don't linger. **(This subtraction is the only
   change made in the session that produced this handoff.)**
3. If it's not a git repo / git fails → falls back to `walkFiles`: a recursive
   `readdir` that skips a hardcoded `IGNORE_DIRS` set and does **NOT** read
   `.gitignore`.

The git-based listing was introduced earlier in commits `5ce3a92 "add search"` /
`83b891e` — it is **not** new, and not the result of this session.

## Is it a good or bad change?
**Pros:** fast; `.gitignore` honored automatically; skips junk (node_modules, dist).

**Cons / valid concerns (owner flagged these):**
- Depends on git. Non-git projects fall back to `walkFiles`, which ignores
  `.gitignore` and only skips the hardcoded dir set — weaker and inconsistent.
- `git ls-files` reflects the **git index**, which can diverge from disk. That's
  why a deleted-but-unstaged file showed up. The `--deleted` subtraction fixes
  that specific case, but the model is still "index state," not "disk state."
- Spawns a `git` subprocess on every call — latency on large repos; can feel stale.

## Owner's preferred direction (read from disk, not git)
Replace git with a single recursive filesystem walk that:
- reads `.gitignore` (use the `ignore` npm package for correct semantics incl.
  nested `.gitignore` files and negation rules) and **prunes ignored directories
  during recursion** (stop descending into `node_modules`/`dist`/etc.),
- behaves identically with or without git, always matches disk, no subprocess.

Trade-off: you must reproduce `.gitignore` semantics yourself (git does this
perfectly today). The `ignore` library covers essentially all of it. This is the
recommended refactor; it's not urgent (the `--deleted` fix keeps the current
git path disk-accurate for git repos in the meantime).

## Current status
The `--deleted` fix is in the working tree (uncommitted). The **Electron main
process must be rebuilt/restarted** for ⌘P / Files / Search to stop showing the
deleted file — the running app still has the pre-fix compiled main process.
