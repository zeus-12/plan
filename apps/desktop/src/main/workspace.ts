import { join } from "path";
import { resolveProjectCwd } from "./providers/claude-code/projects";

/**
 * Resolve a workspace address — an `encoded` project key plus optional
 * `subPath` (one git sub-repo inside a multi-repo project) — to its absolute
 * cwd. The one place the join rule lives; git ops, blame, file reads, image
 * diffs, and pty spawns all address workspaces through this.
 *
 * github.ts deliberately does NOT use it: a PR view needs the discovered git
 * repo root (with a fallback to the first repo), not a path join.
 */
export async function resolveWorkspaceCwd(
  encoded: string,
  subPath = "",
): Promise<string> {
  const base = await resolveProjectCwd(encoded);
  return subPath ? join(base, subPath) : base;
}
