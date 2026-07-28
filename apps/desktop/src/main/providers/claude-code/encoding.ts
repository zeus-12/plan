/**
 * Claude's cwd ↔ project-dir-name encoding, in one place. Claude names a
 * session's transcript folder under ~/.claude/projects by replacing every
 * non-alphanumeric char of the cwd with "-"; everything that must agree with
 * that (session lookup, worktree naming, archive keys) encodes through here.
 *
 * The encoding is LOSSY: a real "-", space, ".", or "(" in a path is
 * indistinguishable from a separator once encoded —
 * "/Users/x/hacker rank ats" → "-Users-x-hacker-rank-ats" and
 * "/Users/x/copilot (ic)"   → "-Users-x-copilot--ic-".
 */

/** Encode a cwd exactly the way Claude names its transcript folder. Must match
 *  the directory names Claude creates, or session lookups miss. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Best-effort inverse of {@link encodeCwd} — lossy (see module doc), so use it
 * only as a last resort; prefer claude-projects' resolveProjectCwd, which
 * reads the real cwd from the session JSONL.
 */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

/**
 * Reduce a path segment to chars where our encoding == Claude's (no "." etc),
 * for paths the APP invents (e.g. worktree folder names) — built only from
 * safe segments, the lossy decode can't garble them.
 */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}
