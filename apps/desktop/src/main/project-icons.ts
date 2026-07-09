import { access, mkdir, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";
import { net } from "electron";
import { PLAN_DIR } from "./plan-config";
import { gitSafe } from "./git-exec";
import { resolveProjectCwd } from "./claude-projects";
import { discoverRepos } from "./git";

/** Downloaded GitHub avatars live here, one file per owner, reused forever. */
const AVATAR_DIR = join(PLAN_DIR, "icons");

/**
 * Icon files a repo conventionally ships, relative to a scan root, best first.
 * "Best" means renders well at ~16px: prefer the high-res PWA/touch icons over
 * a 16×16 favicon.ico. `build/icon.png` is the electron-builder app icon.
 */
const ICON_CANDIDATES = [
  "public/apple-touch-icon.png",
  "public/favicon/apple-touch-icon.png",
  "src/app/icon.png",
  "app/icon.png",
  "public/icon.png",
  "public/favicon.svg",
  "public/favicon.png",
  "src/app/favicon.ico",
  "app/favicon.ico",
  "public/favicon.ico",
  "build/icon.png",
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function findIconIn(root: string): Promise<string | null> {
  for (const rel of ICON_CANDIDATES) {
    const p = join(root, rel);
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * Find an icon file shipped by the project itself: the conventional favicon /
 * touch-icon / app-icon paths at the project root, then inside `apps/*`
 * (alphabetically, so a monorepo resolves deterministically).
 */
async function findLocalIcon(cwd: string): Promise<string | null> {
  const atRoot = await findIconIn(cwd);
  if (atRoot) return atRoot;

  let apps: string[];
  try {
    const entries = await readdir(join(cwd, "apps"), { withFileTypes: true });
    apps = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const name of apps) {
    const found = await findIconIn(join(cwd, "apps", name));
    if (found) return found;
  }
  return null;
}

/** Owner ("zeus-12") from a GitHub origin URL, https or ssh. Null otherwise. */
function githubOwner(originUrl: string): string | null {
  const m = originUrl.match(/github\.com[:/]([^/]+)\//);
  return m ? m[1] : null;
}

async function originUrl(repoPath: string): Promise<string | null> {
  const r = await gitSafe(repoPath, ["config", "--get", "remote.origin.url"]);
  const url = r.stdout.trim();
  return r.ok && url ? url : null;
}

/**
 * Download the owner's GitHub avatar once into ~/.plan/icons and return the
 * cached file's path. Already-downloaded avatars are reused without a network
 * hit (delete the file to force a refresh). Any failure — offline, 404,
 * non-image response — returns null; the caller falls back to no icon.
 */
async function githubAvatarFile(owner: string): Promise<string | null> {
  // Owner comes from a git URL, but never let a weird one escape the dir.
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return null;
  const file = join(AVATAR_DIR, `github-${owner}.png`);
  if (await exists(file)) return file;

  try {
    const res = await net.fetch(`https://github.com/${owner}.png?size=128`, {
      headers: { "User-Agent": "plan-desktop" },
    });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(AVATAR_DIR, { recursive: true });
    await writeFile(file, buf);
    return file;
  } catch {
    return null;
  }
}

async function resolveIcon(encoded: string): Promise<string | null> {
  const cwd = await resolveProjectCwd(encoded);

  const local = await findLocalIcon(cwd);
  if (local) return pathToFileURL(local).href;

  // No icon in the tree — fall back to the GitHub owner's avatar. For a
  // multi-repo project folder the first repo's origin decides.
  const repos = await discoverRepos(encoded);
  const origin = repos.length > 0 ? await originUrl(repos[0].path) : null;
  const owner = origin ? githubOwner(origin) : null;
  if (!owner) return null;

  const avatar = await githubAvatarFile(owner);
  return avatar ? pathToFileURL(avatar).href : null;
}

// Resolution touches the filesystem and possibly the network, so memoize the
// in-flight promise per project for the app's lifetime. A failed lookup is NOT
// cached — a later call retries (e.g. once the machine is back online).
const iconCache = new Map<string, Promise<string | null>>();

function getProjectIcon(encoded: string): Promise<string | null> {
  const cached = iconCache.get(encoded);
  if (cached) return cached;
  const p = resolveIcon(encoded).then(
    (url) => {
      if (url === null) iconCache.delete(encoded);
      return url;
    },
    () => {
      iconCache.delete(encoded);
      return null;
    },
  );
  iconCache.set(encoded, p);
  return p;
}

/** file:// icon URLs for the given projects; projects with no icon are omitted. */
export async function getProjectIcons(
  encodeds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    encodeds.map(async (encoded) => {
      try {
        const url = await getProjectIcon(encoded);
        if (url) out[encoded] = url;
      } catch {
        // no icon for this project
      }
    }),
  );
  return out;
}
