import { readFile, readdir } from "fs/promises";
import type { Dirent } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { resolveProjectCwd } from "./projects";
import type { SkillInfo } from "@/common/shared-types";

const MAX_DESC = 240;

/**
 * Parse a leading YAML frontmatter block (`--- … ---`) into flat key/value
 * pairs. Deliberately minimal: SKILL.md frontmatter we care about (`name`,
 * `description`) is always flat scalars, so we avoid pulling in a YAML parser.
 */
function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJsonSafe(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Manifest paths are relative to the plugin root; `.` and `./` mean the root. */
function resolveManifestPath(root: string, rel: string): string {
  const trimmed = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? root : join(root, trimmed);
}

function toPathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

/** Skill frontmatter booleans also accept yes/no/on/off/1/0, in any case. */
function isFalsy(value: string | undefined): boolean {
  return value !== undefined && /^(false|no|off|0)$/i.test(value.trim());
}

/**
 * `user-invocable: false` marks background knowledge Claude loads on its own,
 * so it must stay out of a `/` menu. `disable-model-invocation` is the mirror
 * image — manual-only — and belongs in the menu.
 */
function hiddenFromMenu(fm: Record<string, string>): boolean {
  return isFalsy(fm["user-invocable"]);
}

/**
 * One skill from a directory holding a `SKILL.md`. The invocation name comes
 * from the frontmatter so it survives version-stamped install dirs; the
 * directory basename is the fallback.
 */
async function readSkillDir(
  dir: string,
  source: SkillInfo["source"],
  prefix: string,
): Promise<SkillInfo | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  if (hiddenFromMenu(fm)) return null;
  const name = (fm.name || basename(dir)).trim();
  if (!name) return null;
  return {
    name: prefix + name,
    description: (fm.description ?? "").slice(0, MAX_DESC),
    source,
  };
}

/** Every `<dir>/<name>/SKILL.md` one level down. */
async function readSkillsIn(
  dir: string,
  source: SkillInfo["source"],
  prefix: string,
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  for (const e of await readDirSafe(dir)) {
    // Accept directories AND symlinks-to-directories (personal skills are
    // commonly symlinked from a dotfiles repo); isDirectory() is false for a
    // symlink, so just skip plain files and let the SKILL.md read decide.
    if (e.isFile()) continue;
    const skill = await readSkillDir(join(dir, e.name), source, prefix);
    if (skill) out.push(skill);
  }
  return out;
}

async function readCommandFile(
  file: string,
  source: SkillInfo["source"],
  prefix: string,
): Promise<SkillInfo | null> {
  let text = "";
  try {
    text = await readFile(file, "utf-8");
  } catch {
    // keep the command even if unreadable — the filename alone defines /name
  }
  const fm = parseFrontmatter(text);
  if (hiddenFromMenu(fm)) return null;
  return {
    name: prefix + basename(file).replace(/\.md$/, ""),
    description: (fm.description ?? "").slice(0, MAX_DESC),
    source,
  };
}

/** Every `<dir>/<name>.md`, each of which invokes as `/name`. */
async function readCommandsIn(
  dir: string,
  source: SkillInfo["source"],
  prefix: string,
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  for (const e of await readDirSafe(dir)) {
    // Files or symlinked files ending in .md; skip subdirectories.
    if (e.isDirectory() || !e.name.endsWith(".md")) continue;
    const cmd = await readCommandFile(join(dir, e.name), source, prefix);
    if (cmd) out.push(cmd);
  }
  return out;
}

/**
 * Discover the skills/commands a base directory exposes:
 *   - `skills/<name>/SKILL.md` — the Agent Skills standard
 *   - `commands/<name>.md`     — custom commands (also create `/name`)
 * Both invoke as `/name`, so they share a list.
 */
async function readBase(
  baseDir: string,
  source: SkillInfo["source"],
): Promise<SkillInfo[]> {
  const [skills, commands] = await Promise.all([
    readSkillsIn(join(baseDir, "skills"), source, ""),
    readCommandsIn(join(baseDir, "commands"), source, ""),
  ]);
  return [...skills, ...commands];
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  commands?: unknown;
  defaultEnabled?: unknown;
}

/**
 * Skills and commands a single installed plugin exposes, namespaced
 * `<pluginName>:<name>` the way the Claude Code TUI addresses them.
 *
 * A manifest that declares `skills` or `commands` is the whole list for that
 * field — the matching default directory is not scanned, so a plugin never
 * exposes a `SKILL.md` it chose to leave out. Only a plugin that declares
 * nothing falls back to the conventional `skills/` and `commands/` layout.
 *
 * A declared skills path is either a skill directory itself (holds `SKILL.md`)
 * or a parent to scan — both are legal, so try the direct read first.
 */
async function readPlugin(
  installPath: string,
  manifest: PluginManifest,
  prefix: string,
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];

  const declaredSkills = toPathList(manifest.skills);
  if (declaredSkills.length === 0) {
    out.push(
      ...(await readSkillsIn(join(installPath, "skills"), "plugin", prefix)),
    );
  } else {
    for (const rel of declaredSkills) {
      const dir = resolveManifestPath(installPath, rel);
      const direct = await readSkillDir(dir, "plugin", prefix);
      if (direct) out.push(direct);
      else out.push(...(await readSkillsIn(dir, "plugin", prefix)));
    }
  }

  // A plugin with no skills/ directory and no `skills` field ships its single
  // skill as a SKILL.md at the root.
  if (out.length === 0 && declaredSkills.length === 0) {
    const root = await readSkillDir(installPath, "plugin", prefix);
    if (root) out.push(root);
  }

  const declaredCommands = toPathList(manifest.commands);
  if (declaredCommands.length === 0) {
    out.push(
      ...(await readCommandsIn(
        join(installPath, "commands"),
        "plugin",
        prefix,
      )),
    );
  } else {
    for (const rel of declaredCommands) {
      const path = resolveManifestPath(installPath, rel);
      if (path.endsWith(".md")) {
        const cmd = await readCommandFile(path, "plugin", prefix);
        if (cmd) out.push(cmd);
      } else {
        out.push(...(await readCommandsIn(path, "plugin", prefix)));
      }
    }
  }

  return out;
}

interface InstalledPluginEntry {
  installPath?: string;
}

/**
 * The `enabledPlugins` map, keyed `<name>@<marketplace>`, merged across the
 * settings files Claude Code reads — later files win.
 */
async function readEnabledPlugins(cwd: string): Promise<Map<string, boolean>> {
  const files = [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  const merged = new Map<string, boolean>();
  for (const file of files) {
    const parsed = (await readJsonSafe(file)) as
      | { enabledPlugins?: Record<string, unknown> }
      | undefined;
    const entries = parsed?.enabledPlugins;
    if (!entries || typeof entries !== "object") continue;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "boolean") merged.set(key, value);
    }
  }
  return merged;
}

/**
 * Skills/commands from every enabled plugin, read straight from the install
 * paths recorded in `~/.claude/plugins/installed_plugins.json` — the same source
 * of truth the CLI uses.
 */
async function listPluginSkills(cwd: string): Promise<SkillInfo[]> {
  const manifestPath = join(
    homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json",
  );
  const [parsed, enabled] = await Promise.all([
    readJsonSafe(manifestPath) as Promise<
      { plugins?: Record<string, InstalledPluginEntry[]> } | undefined
    >,
    readEnabledPlugins(cwd),
  ]);
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const out: SkillInfo[] = [];
  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const inst of installs) {
      const installPath = inst?.installPath;
      if (typeof installPath !== "string") continue;
      const manifest =
        ((await readJsonSafe(
          join(installPath, ".claude-plugin", "plugin.json"),
        )) as PluginManifest | undefined) ?? {};

      const enabledForKey = enabled.get(key);
      const on =
        enabledForKey ??
        (typeof manifest.defaultEnabled === "boolean"
          ? manifest.defaultEnabled
          : true);
      if (!on) continue;

      // The marketplace entry name — the `enabledPlugins` key minus its
      // `@marketplace` suffix — is what namespaces the plugin's components.
      const pluginName =
        key.split("@")[0] ||
        (typeof manifest.name === "string" ? manifest.name : "") ||
        (installPath.split("/").filter(Boolean).slice(-2, -1)[0] ?? "");
      const prefix = pluginName ? `${pluginName}:` : "";
      out.push(...(await readPlugin(installPath, manifest, prefix)));
    }
  }
  return out;
}

/**
 * Every skill/command invocable as `/name` for a project: enabled plugins, the
 * user's `~/.claude`, and the project's own `.claude`. De-duped by name (project
 * > personal > plugin) and sorted, ready for the chat composer's `/` menu.
 *
 * Note: skills bundled inside the Claude Code CLI itself (e.g. `/code-review`)
 * are not discoverable on disk here, so they are intentionally not listed —
 * better to omit them than to guess at a path that may not exist.
 */
export async function listSkills(encoded: string): Promise<SkillInfo[]> {
  const cwd = await resolveProjectCwd(encoded);
  const [plugins, personal, project] = await Promise.all([
    listPluginSkills(cwd),
    readBase(join(homedir(), ".claude"), "personal"),
    readBase(join(cwd, ".claude"), "project"),
  ]);
  const byName = new Map<string, SkillInfo>();
  for (const s of [...plugins, ...personal, ...project]) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
