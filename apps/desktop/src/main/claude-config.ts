import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { resolveProjectCwd } from "./claude-projects";
import { CLAUDE_PROJECTS_DIR } from "./claude-sessions";
import type {
  ClaudeConfigBundle,
  ClaudeConfigFile,
  ClaudeConfigScope,
} from "../shared-types";

/**
 * Resolves and edits the files that shape Claude's behaviour, the same way
 * Claude Code itself loads them:
 *
 *  - global: ~/.claude/CLAUDE.md (applies to every project)
 *  - project: the CLAUDE.md cascade — walking the project cwd UP to the
 *    filesystem root, every CLAUDE.md (and CLAUDE.local.md) is loaded and
 *    concatenated. It is additive, not closest-wins.
 *  - memory: the per-project memory store under
 *    ~/.claude/projects/<encoded>/memory/*.md, with MEMORY.md (the index) first.
 */

const HOME = homedir();
const GLOBAL_CLAUDE_MD = join(HOME, ".claude", "CLAUDE.md");

/** Replace the home dir with ~ for display. */
function tildify(path: string): string {
  return path === HOME || path.startsWith(HOME + "/")
    ? "~" + path.slice(HOME.length)
    : path;
}

async function readMaybe(
  path: string,
): Promise<{ text: string; exists: boolean }> {
  try {
    return { text: await readFile(path, "utf-8"), exists: true };
  } catch {
    return { text: "", exists: false };
  }
}

async function toConfigFile(
  path: string,
  scope: ClaudeConfigScope,
): Promise<ClaudeConfigFile> {
  const { text, exists } = await readMaybe(path);
  return { path, label: tildify(path), scope, text, exists };
}

/**
 * Every CLAUDE.md / CLAUDE.local.md candidate from `cwd` up to the filesystem
 * root, nearest first. Matches Claude Code's upward walk.
 */
function cascadeCandidates(cwd: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (;;) {
    out.push(join(dir, "CLAUDE.md"));
    out.push(join(dir, "CLAUDE.local.md"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function readProjectCascade(
  encoded: string,
): Promise<ClaudeConfigFile[]> {
  const cwd = await resolveProjectCwd(encoded);
  const candidates = cascadeCandidates(cwd);
  const files = await Promise.all(
    candidates.map((p) => toConfigFile(p, "project")),
  );
  // Keep only files that exist, but always surface the project-root CLAUDE.md
  // (the first candidate) even when missing, so the user can create it.
  return files.filter((f, i) => f.exists || i === 0);
}

async function readMemory(encoded: string): Promise<ClaudeConfigFile[]> {
  const dir = join(CLAUDE_PROJECTS_DIR, encoded, "memory");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  // MEMORY.md (the index) first, then the rest alphabetically.
  names.sort((a, b) =>
    a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b),
  );
  return Promise.all(names.map((n) => toConfigFile(join(dir, n), "memory")));
}

export async function readClaudeConfig(
  encoded: string | null,
): Promise<ClaudeConfigBundle> {
  const [global, project, memory] = await Promise.all([
    toConfigFile(GLOBAL_CLAUDE_MD, "global"),
    encoded ? readProjectCascade(encoded) : Promise.resolve([]),
    encoded ? readMemory(encoded) : Promise.resolve([]),
  ]);
  return { global, project, memory };
}

/**
 * Guard against arbitrary writes from the renderer: only the global CLAUDE.md,
 * a CLAUDE.md/CLAUDE.local.md cascade file, or a markdown file inside the
 * per-project memory tree may be written.
 */
function assertWritable(path: string): void {
  if (path === GLOBAL_CLAUDE_MD) return;
  const base = basename(path);
  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") return;
  if (path.startsWith(CLAUDE_PROJECTS_DIR + "/") && path.endsWith(".md"))
    return;
  throw new Error(`Refusing to write outside Claude config files: ${path}`);
}

export async function writeClaudeConfig(
  path: string,
  text: string,
): Promise<{ ok: true }> {
  assertWritable(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf-8");
  return { ok: true };
}
