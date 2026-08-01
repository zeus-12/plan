import { excerpt } from "./excerpt";

export interface Annotation {
  id: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  comment: string;
  side: "left" | "right";
  /** Optional context for the generated copy-message (file path, line range). */
  context?: AnnotationContext;
}

export interface AnnotationContext {
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /** Which surface the selection came from. Drives the glyph on the comment
   *  popover's source pill; absent means the surface hasn't been wired yet. */
  kind?: "file" | "diff" | "pr" | "chat";
  /** Diff only: which version of the file the selection sits in. `left` is the
   *  original, `right` the changed one — it is the pane you dragged in, not a
   *  claim that those particular lines changed. */
  side?: "left" | "right";
  /** PR only. Kept out of `filePath` so the path can truncate from the left
   *  without eating the number. */
  pr?: number;
  /** Chat only: 1-based position of the turn in the transcript. */
  turn?: number;
  /** Chat only: who wrote the turn the selection came from. */
  role?: "user" | "assistant";
}

/** Excerpt budgets for the outgoing message. A comment that carries a location
 *  can be followed back to the source, so it needs less of the text inline; one
 *  without a location (chat) has nothing but the excerpt to point at. */
const ANCHORED_EXCERPT_BUDGET = 700;
const UNANCHORED_EXCERPT_BUDGET = 1400;

function locationString(ctx?: AnnotationContext): string | null {
  if (!ctx) return null;
  const { filePath, startLine, endLine, pr, turn, role } = ctx;
  const lineSuffix =
    startLine != null
      ? endLine != null && endLine !== startLine
        ? `:L${startLine}-${endLine}`
        : `:L${startLine}`
      : "";

  const base = filePath
    ? `${filePath}${lineSuffix}`
    : lineSuffix
      ? lineSuffix.replace(/^:/, "")
      : null;

  // The PR number lives beside the path rather than inside it, so the popover
  // can truncate the path without eating the number. Re-joined here.
  if (pr != null) return base ? `PR #${pr} · ${base}` : `PR #${pr}`;

  if (turn != null) {
    return `chat · ${role === "user" ? "you" : "Claude"}, turn ${turn}`;
  }
  return base;
}

function formatAnnotation(a: Annotation, idx: number): string {
  const loc = locationString(a.context);
  const ex = excerpt(
    a.selectedText,
    loc ? ANCHORED_EXCERPT_BUDGET : UNANCHORED_EXCERPT_BUDGET,
  );

  // A multi-line quote interpolated into `Regarding: "…"` breaks out of the
  // 3-space indent on every line after the first, so anything spanning lines
  // gets a block instead, with the true size stated where the reader can act
  // on it.
  if (ex.text.includes("\n")) {
    const size = `${ex.totalLines} lines, ${ex.totalChars} chars`;
    const quoted = ex.text
      .split("\n")
      .map((line) => `   > ${line}`)
      .join("\n");
    const header = loc ? `${idx}. ${loc} — ${size}` : `${idx}. ${size}`;
    return `${header}\n${quoted}\n   → ${a.comment}`;
  }

  const header = loc
    ? `${idx}. ${loc}\n   Regarding: "${ex.text}"`
    : `${idx}. Regarding: "${ex.text}"`;
  return `${header}\n   → ${a.comment}`;
}

export interface MessageOptions {
  /**
   * Optional opening line. Pass an empty string to omit it entirely (e.g. for
   * the web diff tool, where comments are just collected, not framed as
   * feedback to an AI).
   */
  intro?: string;
  leftLabel?: string;
  rightLabel?: string;
}

export function generateMessage(
  annotations: Annotation[],
  opts: MessageOptions = {},
): string {
  if (annotations.length === 0) return "";

  const intro = opts.intro ?? "I have some feedback:";
  const leftLabel = opts.leftLabel ?? "the left side";
  const rightLabel = opts.rightLabel ?? "the right side";

  const right = annotations.filter((a) => a.side === "right");
  const left = annotations.filter((a) => a.side === "left");

  // Assemble blocks then join — keeps output clean whether or not there's an
  // intro and whether comments span one or both sides.
  const blocks: string[] = [];
  if (intro.trim()) blocks.push(intro);

  if (left.length === 0) {
    blocks.push(right.map((a, i) => formatAnnotation(a, i + 1)).join("\n\n"));
  } else if (right.length === 0) {
    blocks.push(left.map((a, i) => formatAnnotation(a, i + 1)).join("\n\n"));
  } else {
    let idx = 1;
    const rightLines = right.map((a) => formatAnnotation(a, idx++));
    blocks.push(`On ${rightLabel}:\n\n${rightLines.join("\n\n")}`);
    const leftLines = left.map((a) => formatAnnotation(a, idx++));
    blocks.push(`On ${leftLabel}:\n\n${leftLines.join("\n\n")}`);
  }

  return blocks.join("\n\n");
}
