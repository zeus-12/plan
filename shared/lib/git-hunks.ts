/**
 * Parse a single-file unified-diff body (as produced by `git diff`) into its
 * file header and individual hunks. Each hunk can then be reassembled into a
 * minimal patch suitable for `git apply [--cached] [--reverse]`.
 */

export interface GitHunk {
  /** The `@@ -X,Y +A,B @@` line (header only, no body). */
  header: string;
  /** All hunk-body lines joined by "\n" (each prefixed by ' ', '+', or '-'). */
  body: string;
  /** Counts of +/- lines for display. */
  additions: number;
  deletions: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ParsedFileDiff {
  /** Lines from `diff --git` through `+++ b/...`, joined by "\n". */
  fileHeader: string;
  hunks: GitHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseFileDiff(body: string): ParsedFileDiff {
  const lines = body.split("\n");
  const headerEndIdx = lines.findIndex((l) => l.startsWith("@@"));
  const headerLines =
    headerEndIdx === -1 ? lines : lines.slice(0, headerEndIdx);
  const fileHeader = headerLines.join("\n");

  if (headerEndIdx === -1) return { fileHeader, hunks: [] };

  const hunks: GitHunk[] = [];
  let i = headerEndIdx;
  while (i < lines.length) {
    const headerLine = lines[i];
    if (!headerLine.startsWith("@@")) {
      i++;
      continue;
    }
    const m = headerLine.match(HUNK_RE);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] ? parseInt(m[4], 10) : 1;
    i++;
    const bodyLines: string[] = [];
    let additions = 0;
    let deletions = 0;
    while (
      i < lines.length &&
      !lines[i].startsWith("@@") &&
      !lines[i].startsWith("diff --git")
    ) {
      const l = lines[i];
      bodyLines.push(l);
      if (l.startsWith("+") && !l.startsWith("+++")) additions++;
      else if (l.startsWith("-") && !l.startsWith("---")) deletions++;
      i++;
    }
    hunks.push({
      header: headerLine,
      body: bodyLines.join("\n"),
      additions,
      deletions,
      oldStart,
      oldCount,
      newStart,
      newCount,
    });
  }
  return { fileHeader, hunks };
}

/** Reassemble a minimal patch for just one hunk, suitable for `git apply`. */
export function buildSingleHunkPatch(parsed: ParsedFileDiff, hunkIdx: number): string {
  const hunk = parsed.hunks[hunkIdx];
  if (!hunk) throw new Error(`No hunk at index ${hunkIdx}`);
  // `git apply` needs a trailing newline.
  return `${parsed.fileHeader}\n${hunk.header}\n${hunk.body}\n`;
}

/** Preview text: first non-context line, truncated. */
export function hunkPreview(hunk: GitHunk, maxLen = 80): string {
  for (const line of hunk.body.split("\n")) {
    if (line.startsWith("+") || line.startsWith("-")) {
      const text = line.slice(1).trim();
      return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
    }
  }
  return `@@ ${hunk.header.slice(2).trim()}`;
}
