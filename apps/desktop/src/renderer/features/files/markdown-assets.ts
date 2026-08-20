/**
 * Image sources in a markdown file on disk are relative to that file, which
 * means nothing to the renderer's own URL — the markdown preview rewrites them
 * to `file://` URLs before react-markdown ever puts them in an <img>.
 */

/** A URL that already names its own source (http:, data:, file:, //host/…). */
function isAbsoluteUrl(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

/** POSIX normalization of an absolute path: drops "." and applies "..". */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

export interface MarkdownAssetBase {
  /** Absolute directory of the markdown file itself. */
  dirAbs: string;
  /** Absolute project root; null when it couldn't be resolved. */
  rootAbs: string | null;
  /** Worktree revision — Chromium caches a `file://` URL forever otherwise. */
  revision: number;
}

/**
 * A `file://` URL for `src`, or `src` unchanged when it is already absolute or
 * points outside the project. Returning the raw source is deliberate: a broken
 * image is honest, a file:// URL to somewhere outside the project is not.
 */
export function resolveMarkdownAssetSrc(
  src: string,
  { dirAbs, rootAbs, revision }: MarkdownAssetBase,
): string {
  if (!src || src.startsWith("#") || isAbsoluteUrl(src)) return src;
  const base = src.startsWith("/") ? rootAbs : dirAbs;
  if (!base) return src;
  const abs = normalizeAbsolute(`${base}/${src}`);
  if (rootAbs && abs !== rootAbs && !abs.startsWith(`${rootAbs}/`)) return src;
  // encodeURI leaves "#" and "?" alone; in a path both would truncate the URL.
  const encoded = encodeURI(abs).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `file://${encoded}?v=${revision}`;
}

/**
 * Split an absolute file path into the project root and the file's directory,
 * given the project-relative path it was resolved from. The root is only
 * reported when `abs` really ends with `relPath` — otherwise root-absolute
 * image sources stay unresolved rather than guessed.
 */
export function markdownAssetBase(
  abs: string,
  relPath: string,
  revision: number,
): MarkdownAssetBase {
  const suffix = `/${relPath}`;
  const rootAbs = abs.endsWith(suffix) ? abs.slice(0, -suffix.length) : null;
  const i = abs.lastIndexOf("/");
  return { dirAbs: i <= 0 ? "/" : abs.slice(0, i), rootAbs, revision };
}
