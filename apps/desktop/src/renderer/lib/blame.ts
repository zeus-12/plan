import {
  UNCOMMITTED_BLAME_HASH,
  type BlameCommit,
  type BlameResult,
} from "../../shared-types";
import { relativeTime } from "./time";

/** Longest inline blame annotation before the summary is ellipsized. */
const BLAME_LABEL_MAX = 90;

/**
 * A blame result tagged with the exact text it was computed for. Viewers
 * blame the text they render (`blameContents`) and keep the source alongside,
 * so "does this blame describe what's on screen?" is a reference-equality
 * check — never a heuristic. A stale result (text changed while the fetch was
 * in flight, or a not-yet-cleared previous file) simply fails the tag check
 * and renders nothing.
 */
export interface TextBlame extends BlameResult {
  forText: string;
}

/** Tag a fetched blame with its source text (null-passthrough for misses). */
export function tagBlame(
  result: BlameResult | null,
  forText: string,
): TextBlame | null {
  return result && { ...result, forText };
}

export interface BlameLineInfo {
  commit: BlameCommit | null;
  uncommitted: boolean;
  isYou: boolean;
  /** The inline annotation text: "You, 2 days ago • subject". */
  label: string;
}

/** Annotation info for one 0-based line, or null when nothing is known. */
export function blameLineInfo(
  blame: BlameResult,
  lineIdx: number,
): BlameLineInfo | null {
  const hash = blame.lineHashes[lineIdx];
  if (!hash) return null;
  const uncommitted = hash === UNCOMMITTED_BLAME_HASH;
  const commit = blame.commits[hash] ?? null;
  if (!uncommitted && !commit) return null;
  const isYou =
    uncommitted ||
    (!!blame.userEmail && commit?.authorMail === blame.userEmail);
  const who = isYou ? "You" : commit!.author;
  let label = uncommitted
    ? `${who} • Uncommitted changes`
    : `${who}, ${relativeTime(commit!.authorTime)} • ${commit!.summary}`;
  if (label.length > BLAME_LABEL_MAX)
    label = label.slice(0, BLAME_LABEL_MAX) + "…";
  return { commit, uncommitted, isYou, label };
}
