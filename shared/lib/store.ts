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
}

const MESSAGE_TRUNCATE_LEN = 120;

function locationString(ctx?: AnnotationContext): string | null {
  if (!ctx) return null;
  const { filePath, startLine, endLine } = ctx;
  const lineSuffix =
    startLine != null
      ? endLine != null && endLine !== startLine
        ? `:L${startLine}-${endLine}`
        : `:L${startLine}`
      : "";
  if (filePath) return `${filePath}${lineSuffix}`;
  if (lineSuffix) return lineSuffix.replace(/^:/, "");
  return null;
}

function formatAnnotation(a: Annotation, idx: number): string {
  const truncated =
    a.selectedText.length > MESSAGE_TRUNCATE_LEN
      ? a.selectedText.slice(0, MESSAGE_TRUNCATE_LEN) + "..."
      : a.selectedText;
  const loc = locationString(a.context);
  const header = loc
    ? `${idx}. ${loc}\n   Regarding: "${truncated}"`
    : `${idx}. Regarding: "${truncated}"`;
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
