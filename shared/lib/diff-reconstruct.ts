import { parseFileDiff } from "./git-hunks";

/**
 * Reconstruct a file's *old* text by reverse-applying its unified diff to the
 * *new* text.
 *
 * This exists because a PR's base commit can't be resolved reliably from the
 * client: for a merged PR the base branch has moved forward and absorbed the
 * head, so `merge-base(base, head)` degenerates to `head` and a naive
 * base-blob fetch returns the *post-merge* content — identical to head, so the
 * diff renders as "all unchanged". The head blob, by contrast, is always
 * fetchable (`refs/pull/N/head` persists), and `gh pr diff` gives the
 * authoritative diff. Given those two, the old side is fully determined: walk
 * the hunks, copy unchanged gaps straight from the new text, and within each
 * hunk emit the old side (context + deleted lines, dropping the added ones).
 *
 * No hunks (pure rename, mode change, or binary) → the content is unchanged, so
 * the old text equals the new text.
 */
export function reconstructOldText(newText: string, fileBody: string): string {
  const { hunks } = parseFileDiff(fileBody);
  if (hunks.length === 0) return newText;

  // Split into content lines only. `split("\n")` yields a trailing "" for a
  // newline-terminated file; that "" is the *terminator*, not a content line, so
  // we drop it here and re-add the old side's terminator explicitly at the end.
  // Conflating the two is what makes trailing-newline edits reconstruct wrong.
  const endsWithNewline = newText.endsWith("\n");
  const all = newText.length ? newText.split("\n") : [];
  const contentLen = endsWithNewline && all.length ? all.length - 1 : all.length;

  const oldLines: string[] = [];
  let cursor = 0; // 0-based index into content lines

  for (const h of hunks) {
    // Lines before this hunk are unchanged — identical in old and new.
    const startIdx = Math.max(0, h.newStart - 1);
    for (let i = cursor; i < startIdx && i < contentLen; i++) {
      oldLines.push(all[i]);
    }
    // Emit the hunk's old side: context (' ') and deletions ('-'); drop
    // additions ('+') and the "\ No newline at end of file" marker. Skip empty
    // strings — every real body line carries a prefix char (a blank context
    // line is " ", not ""), so "" is only the trailing artifact of splitting a
    // newline-terminated diff.
    for (const line of h.body.split("\n")) {
      if (line === "") continue;
      const tag = line[0];
      if (tag === "+" || tag === "\\") continue;
      oldLines.push(line.slice(1));
    }
    // Advance past the new-side lines this hunk covered.
    cursor = startIdx + h.newCount;
  }

  // Trailing unchanged content after the last hunk.
  for (let i = cursor; i < contentLen; i++) oldLines.push(all[i]);

  let result = oldLines.join("\n");
  // Re-add the old side's terminator. Files end with a newline unless the diff
  // carries a "\ No newline at end of file" marker on an old-side line.
  if (oldLines.length > 0 && oldSideEndsWithNewline(fileBody)) result += "\n";
  return result;
}

/**
 * Whether the file's *old* side ended with a newline, per the diff. A
 * "\ No newline at end of file" marker applies to the line above it; when that
 * line is an old-side line (context ' ' or deletion '-'), the old file had no
 * trailing newline.
 */
function oldSideEndsWithNewline(fileBody: string): boolean {
  const lines = fileBody.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("\\")) {
      const prevTag = lines[i - 1][0];
      if (prevTag === "-" || prevTag === " ") return false;
    }
  }
  return true;
}
