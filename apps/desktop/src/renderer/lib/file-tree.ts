/**
 * Path-trie file tree — the one implementation behind every VSCode-style file
 * list (the git status list and the Files tab). Callers hand in items with
 * slash-separated paths and get back a sorted tree (dirs first, then files,
 * name-sorted) plus a flatten that gates recursion on the caller's
 * expanded/collapsed state. Generic over the leaf payload so the status list
 * keeps its FileEntry rows and the Files tab its plain paths.
 *
 * NOT for the project sidebar: that tree groups projects by git common-dir (a
 * domain structure), not by path segments — see project-tree.ts.
 */

export interface TreeDir<T> {
  /** Display label. With `compact`, a single-child chain joined ("src/main"). */
  name: string;
  /** Full directory path (the deepest node of a compacted chain). */
  path: string;
  dirs: TreeDir<T>[];
  files: T[];
}

/**
 * Build the tree for `items`. Every path segment except the last becomes a
 * directory node; the item lands in its directory's `files`. `compact` folds
 * single-child folder chains into one node (like `explorer.compactFolders`).
 */
export function buildFileTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  opts: { compact?: boolean } = {},
): TreeDir<T> {
  const root: TreeDir<T> = { name: "", path: "", dirs: [], files: [] };
  const byPath = new Map<string, TreeDir<T>>([["", root]]);
  for (const item of items) {
    const parts = pathOf(item).split("/");
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      let child = byPath.get(acc);
      if (!child) {
        child = { name: parts[i], path: acc, dirs: [], files: [] };
        byPath.set(acc, child);
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(item);
  }
  sortTree(root, pathOf);
  if (opts.compact) compactChains(root);
  return root;
}

function sortTree<T>(dir: TreeDir<T>, pathOf: (item: T) => string): void {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) => {
    const an = pathOf(a).split("/").pop() ?? "";
    const bn = pathOf(b).split("/").pop() ?? "";
    return an.localeCompare(bn);
  });
  for (const d of dir.dirs) sortTree(d, pathOf);
}

/** Fold a → b → c (each a lone child, no files) into one "a/b/c" node. */
function compactChains<T>(dir: TreeDir<T>): void {
  for (let i = 0; i < dir.dirs.length; i++) {
    let child = dir.dirs[i];
    let name = child.name;
    while (child.dirs.length === 1 && child.files.length === 0) {
      const only = child.dirs[0];
      name = `${name}/${only.name}`;
      child = only;
    }
    child.name = name;
    dir.dirs[i] = child;
    compactChains(child);
  }
}

export type FileTreeRow<T> =
  | { kind: "dir"; dir: TreeDir<T>; depth: number }
  | { kind: "file"; file: T; depth: number };

/**
 * Flatten to depth-annotated rows (dirs of a level first, then its files). A
 * directory row is always emitted; its contents follow only when
 * `isOpen(dir.path)` — the caller owns expand-vs-collapse semantics.
 */
export function flattenFileTree<T>(
  root: TreeDir<T>,
  isOpen: (dirPath: string) => boolean,
): FileTreeRow<T>[] {
  const out: FileTreeRow<T>[] = [];
  const walk = (dir: TreeDir<T>, depth: number) => {
    for (const d of dir.dirs) {
      out.push({ kind: "dir", dir: d, depth });
      if (isOpen(d.path)) walk(d, depth + 1);
    }
    for (const f of dir.files) out.push({ kind: "file", file: f, depth });
  };
  walk(root, 0);
  return out;
}

/** Ancestor directory paths of `path` ("a/b/c.ts" → ["a", "a/b"]). */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    out.push(acc);
  }
  return out;
}
