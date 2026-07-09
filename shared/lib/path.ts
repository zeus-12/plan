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
