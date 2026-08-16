/** POSIX-path helpers for the project-relative paths used throughout the app. */

/** Last path segment ("a/b/c.ts" → "c.ts"). The whole path if there's no slash. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Everything before the last slash ("a/b/c.ts" → "a/b"). "" if there's no slash. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Last non-empty segment — tolerant of trailing slashes ("/a/b/" → "b").
 * Used for display names derived from directories (e.g. a project's cwd).
 * Falls back to the input itself when there are no segments.
 */
export function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Project-relative path, or null when the file lives outside the project (a
 *  scratchpad, another repo) and a project-scoped read can't reach it. */
export function relativeToCwd(path: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : null;
}

/**
 * How a path reads in the UI: "./" for a file inside the project, the absolute
 * path for anything else. The leading character is then the answer to "where is
 * this file" — a write into a temp dir or another repo cannot look local.
 */
export function displayPath(path: string, cwd: string | null): string {
  const rel = relativeToCwd(path, cwd);
  return rel === null ? path : `./${rel}`;
}
