import type { DiscoveredRepo, ProjectEntry } from "../../shared-types";

/**
 * A "primary repo" for a project = the first repo discovered there. If the
 * project itself is a git repo, that's its primary. Otherwise, if exactly one
 * sub-repo was found at depth 1, that's the primary. Otherwise null (the
 * project is treated as a container and gets no worktree grouping).
 */
function primaryCommonDir(
  encoded: string,
  repos: Map<string, DiscoveredRepo[]>,
): string | null {
  const list = repos.get(encoded) ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].commonDir;
  // Multiple repos under one project — don't worktree-group it. Each repo
  // shows up in the file view as its own section.
  return null;
}

export interface ProjectGroupNode {
  kind: "group";
  /** Stable id. */
  key: string;
  /** Display label (the repo's basename from its commonDir). */
  name: string;
  children: ProjectEntry[];
  /** Most-recent mtime across children, used for sorting. */
  mtimeMs: number;
}

export interface ProjectLeafNode {
  kind: "project";
  project: ProjectEntry;
}

export type ProjectNode = ProjectGroupNode | ProjectLeafNode;

function repoNameFromCommonDir(commonDir: string): string {
  // <something>/<repo>/.git or .../<repo>/.git/worktrees/<wt>
  // Strip a trailing "/.git[/...]" then take the last path segment.
  let trimmed = commonDir;
  const gitIdx = trimmed.indexOf("/.git");
  if (gitIdx !== -1) trimmed = trimmed.slice(0, gitIdx);
  const segs = trimmed.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? commonDir;
}

/**
 * Build the sidebar tree. Worktrees that share a git common dir collapse
 * under one group; otherwise each project is a standalone leaf. Sorted by
 * most-recent activity.
 */
export function buildProjectTree(
  projects: ProjectEntry[],
  reposByProject: Map<string, DiscoveredRepo[]>,
): ProjectNode[] {
  const groups = new Map<
    string,
    { commonDir: string; entries: ProjectEntry[] }
  >();
  const standalone: ProjectEntry[] = [];

  for (const p of projects) {
    const cd = primaryCommonDir(p.encoded, reposByProject);
    if (!cd) {
      standalone.push(p);
      continue;
    }
    const bucket = groups.get(cd);
    if (bucket) bucket.entries.push(p);
    else groups.set(cd, { commonDir: cd, entries: [p] });
  }

  const nodes: ProjectNode[] = [];
  for (const { commonDir, entries } of groups.values()) {
    if (entries.length >= 2) {
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      nodes.push({
        kind: "group",
        key: `cd::${commonDir}`,
        name: repoNameFromCommonDir(commonDir),
        children: entries,
        mtimeMs: entries[0]?.mtimeMs ?? 0,
      });
    } else {
      for (const e of entries) standalone.push(e);
    }
  }

  for (const p of standalone) nodes.push({ kind: "project", project: p });

  nodes.sort((a, b) => nodeMtime(b) - nodeMtime(a));
  return nodes;
}

function nodeMtime(n: ProjectNode): number {
  return n.kind === "group" ? n.mtimeMs : n.project.mtimeMs;
}

export type VisibleItem =
  | { kind: "group-header"; node: ProjectGroupNode; expanded: boolean }
  | { kind: "leaf"; project: ProjectEntry; depth: number };

export function flattenTree(
  tree: ProjectNode[],
  expanded: Set<string>,
): VisibleItem[] {
  const out: VisibleItem[] = [];
  for (const n of tree) {
    if (n.kind === "project") {
      out.push({ kind: "leaf", project: n.project, depth: 0 });
    } else {
      const isOpen = expanded.has(n.key);
      out.push({ kind: "group-header", node: n, expanded: isOpen });
      if (isOpen) {
        for (const child of n.children) {
          out.push({ kind: "leaf", project: child, depth: 1 });
        }
      }
    }
  }
  return out;
}
