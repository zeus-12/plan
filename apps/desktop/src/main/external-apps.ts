import { execFile } from "child_process";
import { mkdir, stat } from "fs/promises";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import type { ExternalApp, ExternalAppKind } from "../shared-types";
import { pathExists } from "./fs-util";
import { PLAN_DIR } from "./plan-config";
import { resolveWorkspaceCwd } from "./workspace";

/**
 * "Open in…" — launching a project folder or a single file in another macOS
 * app. Which apps exist is answered by the OS (Spotlight, then Launch
 * Services), never by guessing at install paths: an app the user doesn't have
 * must not appear in the menu.
 */

interface AppDefinition {
  id: string;
  label: string;
  /** Candidate bundle ids, best first — editions and rebrands differ. */
  bundleIds: readonly string[];
  kind: ExternalAppKind;
  /**
   * The launcher the app ships INSIDE its bundle, relative to the .app. `open
   * -b` only hands the app a path and lets it decide what to do with it; the
   * CLI takes both the workspace root and the file, so the editor opens the
   * repo with that file focused and the rest of the tree still navigable.
   * Taken from the bundle rather than PATH so it works whether or not the user
   * ever ran the app's "install shell command". Missing at that path → falls
   * back to `open -b`.
   */
  cli?: { path: string; style: CliStyle };
}

/**
 * How a CLI wants "open this file, in this project": VS Code and its forks
 * take the folder positionally and the file behind `--goto`, everything else
 * takes both as plain paths.
 */
type CliStyle = "vscode" | "paths";

function cliArgs(style: CliStyle, root: string, file: string): string[] {
  return style === "vscode" ? [root, "--goto", file] : [root, file];
}

/** The launcher every VS Code fork ships, `<bin>` being its own command name. */
const vscodeCli = (bin: string) => ({
  path: `Contents/Resources/app/bin/${bin}`,
  style: "vscode" as const,
});

/**
 * The apps we know how to open things in. Hardcoded, like every editor picker
 * of this kind (t3code keeps the same table) — the OS can enumerate installed
 * apps but not say which ones are sensible targets for a repo. Entries the
 * user doesn't have are dropped at detection time, so an unused row costs one
 * Spotlight query at startup and nothing after.
 */
const APPS: readonly AppDefinition[] = [
  { id: "finder", label: "Finder", bundleIds: ["com.apple.finder"], kind: "file-manager" },

  {
    id: "cursor",
    label: "Cursor",
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
    kind: "editor",
    cli: vscodeCli("cursor"),
  },
  {
    id: "vscode",
    label: "VS Code",
    bundleIds: ["com.microsoft.VSCode"],
    kind: "editor",
    cli: vscodeCli("code"),
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    bundleIds: ["com.microsoft.VSCodeInsiders"],
    kind: "editor",
    cli: vscodeCli("code-insiders"),
  },
  {
    id: "vscodium",
    label: "VSCodium",
    bundleIds: ["com.vscodium", "com.visualstudio.code.oss"],
    kind: "editor",
    cli: vscodeCli("codium"),
  },
  {
    id: "zed",
    label: "Zed",
    bundleIds: ["dev.zed.Zed", "dev.zed.Zed-Preview"],
    kind: "editor",
    cli: { path: "Contents/MacOS/cli", style: "paths" },
  },
  {
    id: "windsurf",
    label: "Windsurf",
    bundleIds: ["com.exafunction.windsurf"],
    kind: "editor",
    cli: vscodeCli("windsurf"),
  },
  {
    id: "sublime",
    label: "Sublime Text",
    bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
    kind: "editor",
    cli: { path: "Contents/SharedSupport/bin/subl", style: "paths" },
  },
  { id: "xcode", label: "Xcode", bundleIds: ["com.apple.dt.Xcode"], kind: "editor" },
  { id: "idea", label: "IntelliJ IDEA", bundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"], kind: "editor" },
  { id: "webstorm", label: "WebStorm", bundleIds: ["com.jetbrains.WebStorm"], kind: "editor" },
  { id: "pycharm", label: "PyCharm", bundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"], kind: "editor" },
  { id: "goland", label: "GoLand", bundleIds: ["com.jetbrains.goland"], kind: "editor" },
  { id: "rustrover", label: "RustRover", bundleIds: ["com.jetbrains.rustrover"], kind: "editor" },
  { id: "phpstorm", label: "PhpStorm", bundleIds: ["com.jetbrains.PhpStorm"], kind: "editor" },
  { id: "rubymine", label: "RubyMine", bundleIds: ["com.jetbrains.rubymine"], kind: "editor" },
  { id: "clion", label: "CLion", bundleIds: ["com.jetbrains.CLion"], kind: "editor" },
  { id: "rider", label: "Rider", bundleIds: ["com.jetbrains.rider"], kind: "editor" },
  { id: "datagrip", label: "DataGrip", bundleIds: ["com.jetbrains.datagrip"], kind: "editor" },

  { id: "ghostty", label: "Ghostty", bundleIds: ["com.mitchellh.ghostty"], kind: "terminal" },
  { id: "terminal", label: "Terminal", bundleIds: ["com.apple.Terminal"], kind: "terminal" },
  { id: "iterm", label: "iTerm", bundleIds: ["com.googlecode.iterm2"], kind: "terminal" },
  { id: "warp", label: "Warp", bundleIds: ["dev.warp.Warp-Stable"], kind: "terminal" },
  { id: "wezterm", label: "WezTerm", bundleIds: ["com.github.wez.wezterm"], kind: "terminal" },
  { id: "kitty", label: "kitty", bundleIds: ["net.kovidgoyal.kitty"], kind: "terminal" },
  { id: "alacritty", label: "Alacritty", bundleIds: ["org.alacritty"], kind: "terminal" },
];

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) =>
      resolve({ ok: !err, stdout: stdout ?? "" }),
    );
  });
}

/** The app bundle's path, via Spotlight. Null when it isn't indexed. */
async function bundlePath(bundleId: string): Promise<string | null> {
  const r = await run("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`]);
  const first = r.stdout.split("\n")[0]?.trim();
  return r.ok && first?.endsWith(".app") ? first : null;
}

/**
 * Whether Launch Services can resolve the bundle id. `open -R` with no file
 * operand only validates the app — it does not launch it — so this is a safe
 * fallback for apps Spotlight hasn't indexed (indexing disabled, unusual
 * install location).
 */
async function isRegistered(bundleId: string): Promise<boolean> {
  return (await run("/usr/bin/open", ["-Rb", bundleId])).ok;
}

/** Converted app icons, one PNG per app id, refreshed on each detection. */
const ICON_DIR = join(PLAN_DIR, "icons", "apps");

async function plistValue(appPath: string, key: string): Promise<string | null> {
  const r = await run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appPath, "Contents", "Info.plist"),
  ]);
  const value = r.stdout.trim();
  return r.ok && value ? value : null;
}

/**
 * The bundle's .icns file. `CFBundleIconFile` is the declared name, with or
 * without the extension; `CFBundleIconName` is the modern asset-catalog key,
 * which usually still ships a matching loose .icns beside it.
 */
async function icnsPath(appPath: string): Promise<string | null> {
  const names = [
    await plistValue(appPath, "CFBundleIconFile"),
    await plistValue(appPath, "CFBundleIconName"),
  ];
  for (const name of names) {
    if (!name) continue;
    const file = join(
      appPath,
      "Contents",
      "Resources",
      name.endsWith(".icns") ? name : `${name}.icns`,
    );
    if (await pathExists(file)) return file;
  }
  return null;
}

/**
 * The app's real icon as a file:// URL, or null when the bundle keeps it only
 * in a compiled asset catalog (nothing loose to convert) — the menu then shows
 * a neutral placeholder rather than some other app's icon.
 *
 * Electron's `app.getFileIcon` is NOT usable here: on macOS it returns the same
 * generic placeholder for every .app (byte-identical output for Finder, Cursor,
 * Zed and Ghostty alike), so it can't distinguish the apps it's meant to.
 */
async function iconUrl(id: string, appPath: string): Promise<string | null> {
  const icns = await icnsPath(appPath);
  if (!icns) return null;
  try {
    await mkdir(ICON_DIR, { recursive: true });
    const png = join(ICON_DIR, `${id}.png`);
    const r = await run("sips", [
      "-s",
      "format",
      "png",
      "-Z",
      "64",
      icns,
      "--out",
      png,
    ]);
    if (!r.ok || !(await pathExists(png))) return null;
    // Bust the renderer's cache when the app updates its icon.
    const stamp = (await stat(icns)).mtimeMs;
    return `${pathToFileURL(png).href}?v=${Math.round(stamp)}`;
  } catch {
    return null;
  }
}

interface Resolved extends ExternalApp {
  bundleId: string;
  /** Absolute path to the in-bundle launcher, when the bundle ships one. */
  cli: { command: string; style: CliStyle } | null;
}

async function resolveCli(
  def: AppDefinition,
  appPath: string,
): Promise<Resolved["cli"]> {
  if (!def.cli) return null;
  const command = join(appPath, def.cli.path);
  if (!(await pathExists(command))) return null;
  return { command, style: def.cli.style };
}

async function resolve(def: AppDefinition): Promise<Resolved | null> {
  for (const bundleId of def.bundleIds) {
    const path = await bundlePath(bundleId);
    if (path) {
      return {
        id: def.id,
        label: def.label,
        kind: def.kind,
        bundleId,
        icon: await iconUrl(def.id, path),
        cli: await resolveCli(def, path),
      };
    }
    if (await isRegistered(bundleId)) {
      return {
        id: def.id,
        label: def.label,
        kind: def.kind,
        bundleId,
        icon: null,
        cli: null,
      };
    }
  }
  return null;
}

let detected: Promise<Resolved[]> | null = null;

function detect(): Promise<Resolved[]> {
  detected ??= Promise.all(APPS.map(resolve))
    .then((list) => list.filter((a): a is Resolved => a !== null))
    .catch(() => {
      detected = null;
      return [];
    });
  return detected;
}

/** Installed apps we can open things in. Empty off macOS, where none of this
 *  addressing applies — the UI then renders no "Open in" control at all. */
export async function listExternalApps(): Promise<ExternalApp[]> {
  if (process.platform !== "darwin") return [];
  return (await detect()).map(({ id, label, kind, icon }) => ({ id, label, kind, icon }));
}

/**
 * Absolute path for a workspace-relative target: `relPath` null addresses the
 * workspace itself. Addressing goes through resolveWorkspaceCwd so the renderer
 * never has to hold (or send) absolute paths.
 */
export async function resolveTargetPath(
  encoded: string,
  relPath: string | null,
  subPath = "",
): Promise<string> {
  const cwd = await resolveWorkspaceCwd(encoded, subPath);
  return relPath ? join(cwd, relPath) : cwd;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function openInExternalApp(
  appId: string,
  encoded: string,
  relPath: string | null,
  subPath = "",
): Promise<{ ok: boolean; error?: string }> {
  const root = await resolveWorkspaceCwd(encoded, subPath);
  const target = relPath ? join(root, relPath) : root;
  const found = (await detect()).find((a) => a.id === appId);
  if (!found) return { ok: false, error: "That app is no longer installed." };

  const dir = await isDirectory(target);
  // A terminal opens a working directory, so a file target means its parent.
  const path = found.kind === "terminal" && !dir ? dirname(target) : target;

  // Hand the editor the workspace root AND the file, so it opens the repo with
  // that file focused instead of the file on its own — the rest of the tree
  // stays navigable. `open -b` can't express that: it passes a single path and
  // lets the app decide. Fall back to it when the bundle ships no launcher.
  if (found.cli) {
    const r = await run(
      found.cli.command,
      dir ? [target] : cliArgs(found.cli.style, root, target),
    );
    if (r.ok) return { ok: true };
  }

  // Revealing selects the file inside its folder; a folder is opened directly.
  const args =
    found.kind === "file-manager" && !dir
      ? ["-R", path]
      : ["-b", found.bundleId, path];

  const r = await run("/usr/bin/open", args);
  return r.ok ? { ok: true } : { ok: false, error: `Could not open ${found.label}.` };
}
