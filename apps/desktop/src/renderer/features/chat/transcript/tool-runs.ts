import type { ConversationMessage, MessagePart } from "@/common/shared-types";

/**
 * Runs of consecutive machinery rows — tool calls and the thinking between
 * them — folded behind one summary line ("Read files, ran commands").
 *
 * A run is found over the SAME row list the transcript renders, and folding it
 * never changes that list: every message keeps its own `[data-msg-row]`
 * element, folded ones as zero-height placeholders. The row window binary-
 * searches real `offsetTop` over those elements (see row-window), so a fold may
 * not clip rows inside a capped-height box either — a clipped child keeps its
 * natural offsetTop while the rows after it lay out above that, which breaks
 * the sort the search depends on. Hence the peek cap counts ROWS, not pixels.
 */

/** Rows a run must have before folding beats reading it inline. */
const MIN_RUN_ROWS = 3;

/** Rows an opened run shows before the rest go behind "Show all". */
export const RUN_PEEK_ROWS = 14;

export interface ToolRun {
  /** First message's uuid — the fold's identity across streaming appends. */
  key: string;
  /** Row index of the first message in the run. */
  start: number;
  /** Row index of the last message, inclusive. */
  end: number;
  /** Last row shown before the peek cap hides the rest. */
  peekEnd: number;
  /** Summary line, e.g. "Thought, read files, ran commands". */
  label: string;
}

/** Whether a part renders as its own card (plan, question, delivered file) —
 *  content addressed to the reader, so it never folds into a run. */
export type IsCardPart = (
  m: ConversationMessage,
  partIndex: number,
  part: MessagePart,
) => boolean;

function phraseFor(tool: string): string {
  switch (tool) {
    case "Read":
    case "NotebookRead":
      return "read files";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edited files";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "ran commands";
    case "Grep":
    case "Glob":
      return "searched the code";
    case "Skill":
      return "loaded skills";
    case "Task":
    case "Agent":
      return "ran agents";
    case "WebFetch":
    case "WebSearch":
      return "searched the web";
    case "TodoWrite":
      return "updated the todos";
    case "ToolSearch":
      return "loaded tools";
    default:
      return tool.startsWith("mcp__") ? "called MCP tools" : `used ${tool}`;
  }
}

function labelFor(messages: ConversationMessage[]): string {
  const phrases: string[] = [];
  const add = (p: string) => {
    if (!phrases.includes(p)) phrases.push(p);
  };
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === "thinking") add("thought");
      else if (p.kind === "tool_use") add(phraseFor(p.tool));
    }
  }
  const joined = phrases.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function groupable(m: ConversationMessage, isCardPart: IsCardPart): boolean {
  if (m.role !== "assistant" || m.parts.length === 0) return false;
  return m.parts.every((p, i) => {
    if (p.kind === "thinking" || p.kind === "tool_result") return true;
    if (p.kind !== "tool_use") return false;
    return !isCardPart(m, i, p);
  });
}

function hasToolUse(m: ConversationMessage): boolean {
  return m.parts.some((p) => p.kind === "tool_use");
}

export interface ToolRuns {
  runs: ToolRun[];
  /** Row index → its run's index in `runs`, or -1. */
  runOfRow: Int32Array;
}

export function findToolRuns(
  items: ConversationMessage[],
  isCardPart: IsCardPart,
): ToolRuns {
  const runs: ToolRun[] = [];
  const runOfRow = new Int32Array(items.length).fill(-1);

  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const slice = items.slice(start, end + 1);
    // A run of nothing but thinking is left alone: those rows already carry a
    // preview of what they say, and a fold would trade it for a worse one.
    if (end - start + 1 >= MIN_RUN_ROWS && slice.some(hasToolUse)) {
      const index = runs.length;
      runs.push({
        key: items[start].uuid,
        start,
        end,
        peekEnd: Math.min(end, start + RUN_PEEK_ROWS - 1),
        label: labelFor(slice),
      });
      for (let i = start; i <= end; i++) runOfRow[i] = index;
    }
    start = -1;
  };

  for (let i = 0; i < items.length; i++) {
    if (groupable(items[i], isCardPart)) {
      if (start < 0) start = i;
    } else close(i - 1);
  }
  close(items.length - 1);

  return { runs, runOfRow };
}
