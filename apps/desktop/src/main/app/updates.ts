/**
 * Update *notifier* (not an installer).
 *
 * The app ships unsigned, so we can't use Squirrel/electron-updater — macOS
 * refuses to swap in an update whose code signature it can't validate. Instead
 * we honestly do the one thing we *can* verify: ask GitHub whether a newer
 * release exists and, if so, point the user at the download. We never claim an
 * update is "installing" because we have no way to confirm that it is.
 */
import { app, net } from "electron";
import type { UpdateInfo } from "@/common/shared-types";

// The public repo whose Releases are the source of truth for "latest version".
const GITHUB_REPO = "zeus-12/plan";
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Compare two `x.y.z` version strings. Returns >0 if `a` is newer than `b`,
 * <0 if older, 0 if equal. Only the numeric core is compared; any pre-release
 * suffix (`-beta.1`) is ignored, which is safe because our release tags are
 * always plain `vX.Y.Z`. Returns 0 on anything unparseable so we never offer a
 * bogus update from a malformed tag.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Fetch JSON from GitHub using Electron's net stack (honours system proxy). */
async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const res = await net.fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects API requests without a User-Agent.
        "User-Agent": "plan-desktop",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as GithubRelease;
  } catch {
    // Offline, rate-limited, DNS failure — all just mean "can't tell", which we
    // report as "no update" rather than surfacing a scary error.
    return null;
  }
}

/**
 * Returns details of a newer release if one exists, otherwise `null`.
 * `null` also covers every failure mode (offline, parse error, already latest)
 * — the caller shows a banner only on a concrete, newer version.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const release = await fetchLatestRelease();
  if (!release || release.draft || release.prerelease) return null;

  const tag = release.tag_name?.trim();
  if (!tag) return null;

  const latest = tag.replace(/^v/, "");
  const current = app.getVersion();
  if (compareVersions(latest, current) <= 0) return null;

  return {
    version: latest,
    url:
      release.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
    notes: release.body?.trim() ?? "",
  };
}
