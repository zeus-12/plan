import { readFile, readdir } from "fs/promises";
import type { Dirent } from "fs";
import { join } from "path";
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

/**
 * Discover the skills/commands a base directory exposes:
 *   - `skills/<name>/SKILL.md` — the Agent Skills standard
 *   - `commands/<name>.md`     — custom commands (also create `/name`)
 * `prefix` namespaces plugin invocations (e.g. `ralph-loop:`), matching how the
 * Claude Code TUI addresses them. Both invoke as `/name`, so they share a list.
 */
async function readBase(
  baseDir: string,
  source: SkillInfo["source"],
  prefix = "",
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];

  const skillsRoot = join(baseDir, "skills");
  for (const e of await readDirSafe(skillsRoot)) {
    // Accept directories AND symlinks-to-directories (personal skills are
    // commonly symlinked from a dotfiles repo); isDirectory() is false for a
    // symlink, so just skip plain files and let the SKILL.md read decide.
    if (e.isFile()) continue;
    let text: string;
    try {
      text = await readFile(join(skillsRoot, e.name, "SKILL.md"), "utf-8");
    } catch {
      continue; // a directory without a SKILL.md is not a skill
    }
    const fm = parseFrontmatter(text);
    const name = (fm.name || e.name).trim();
    if (name) {
      out.push({
        name: prefix + name,
        description: (fm.description ?? "").slice(0, MAX_DESC),
        source,
      });
    }
  }

  const cmdRoot = join(baseDir, "commands");
  for (const e of await readDirSafe(cmdRoot)) {
    // Files or symlinked files ending in .md; skip subdirectories.
    if (e.isDirectory() || !e.name.endsWith(".md")) continue;
    let text = "";
    try {
      text = await readFile(join(cmdRoot, e.name), "utf-8");
    } catch {
      // keep the command even if unreadable — the filename alone defines /name
    }
    const fm = parseFrontmatter(text);
    out.push({
      name: prefix + e.name.replace(/\.md$/, ""),
      description: (fm.description ?? "").slice(0, MAX_DESC),
      source,
    });
  }

  return out;
}

interface InstalledPluginEntry {
  installPath?: string;
}

/**
 * Skills/commands from every installed plugin, read straight from the install
 * paths recorded in `~/.claude/plugins/installed_plugins.json` — the same source
 * of truth the CLI uses. Each is namespaced `<pluginName>:<name>`.
 */
async function listPluginSkills(): Promise<SkillInfo[]> {
  const manifestPath = join(
    homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json",
  );
  let parsed: { plugins?: Record<string, InstalledPluginEntry[]> };
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    return [];
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const out: SkillInfo[] = [];
  for (const installs of Object.values(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const inst of installs) {
      const installPath = inst?.installPath;
      if (typeof installPath !== "string") continue;
      // Prefer the manifest's declared name; fall back to the install dir.
      let pluginName =
        installPath.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
      try {
        const manifest = JSON.parse(
          await readFile(
            join(installPath, ".claude-plugin", "plugin.json"),
            "utf-8",
          ),
        );
        if (typeof manifest?.name === "string" && manifest.name) {
          pluginName = manifest.name;
        }
      } catch {
        // no manifest — keep the dir-derived name
      }
      const prefix = pluginName ? `${pluginName}:` : "";
      out.push(...(await readBase(installPath, "plugin", prefix)));
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
    listPluginSkills(),
    readBase(join(homedir(), ".claude"), "personal"),
    readBase(join(cwd, ".claude"), "project"),
  ]);
  const byName = new Map<string, SkillInfo>();
  for (const s of [...plugins, ...personal, ...project]) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
