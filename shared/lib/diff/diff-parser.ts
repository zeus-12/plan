import { parseFileDiff } from "./git-hunks";

export type FileStatus = "added" | "deleted" | "renamed" | "modified";

export interface FileDiff {
  /** Path shown in the UI — the "new" path for adds/renames, "old" for deletes. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  /** Body of the diff (header lines through hunks) for this single file. */
  body: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Split a unified `git diff` output into per-file entries. Tolerant of the
 * various header lines git emits (rename, new file mode, etc.).
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  if (!diff.trim()) return [];

  const files: FileDiff[] = [];
  const lines = diff.split("\n");

  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) {
      i++;
      continue;
    }
    // Collect this file's lines until the next `diff --git` or EOF
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith("diff --git")) i++;
    const fileLines = lines.slice(start, i);
    const file = parseSingleFile(fileLines);
    if (file) files.push(file);
  }

  return files;
}

function parseSingleFile(lines: string[]): FileDiff | null {
  if (lines.length === 0) return null;

  // First line: `diff --git a/<oldPath> b/<newPath>`. Paths can contain spaces
  // when not quoted, so fall back to `--- a/` / `+++ b/` headers.
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let status: FileStatus = "modified";
  let binary = false;

  const first = lines[0];
  const m = first.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (m) {
    oldPath = m[1];
    newPath = m[2];
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      newPath = line.slice("rename to ".length);
    } else if (line === "--- /dev/null") {
      oldPath = null;
      status = "added";
    } else if (line === "+++ /dev/null") {
      newPath = null;
      status = "deleted";
    } else if (line.startsWith("--- a/")) {
      oldPath = oldPath ?? line.slice(6);
    } else if (line.startsWith("+++ b/")) {
      newPath = newPath ?? line.slice(6);
    } else if (line.startsWith("Binary files ") && line.includes("differ")) {
      binary = true;
    }
  }

  const path =
    status === "deleted"
      ? (oldPath ?? newPath ?? "?")
      : (newPath ?? oldPath ?? "?");

  const body = lines.join("\n");
  // One counter for the whole codebase: the per-hunk parse (git-hunks) already
  // classifies every +/- line, so the per-file totals are just the hunk sums.
  const { hunks } = parseFileDiff(body);
  const additions = hunks.reduce((n, h) => n + h.additions, 0);
  const deletions = hunks.reduce((n, h) => n + h.deletions, 0);

  return {
    path,
    oldPath,
    newPath,
    status,
    body,
    additions,
    deletions,
    binary,
  };
}
