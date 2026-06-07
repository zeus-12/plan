/**
 * Rich rendering for Claude's AskUserQuestion tool calls in the chat.
 *
 * The question/options come from the tool_use input in the transcript; the
 * eventual tool_result carries the chosen answer (the source of truth for
 * "answered"). For a pending single-choice question with a live terminal, the
 * options are clickable — clicking emulates the exact keystrokes a user would
 * press in the TUI selector (↓ × n, then Enter). We never mark anything as
 * answered ourselves; that state only comes from the transcript.
 */

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** Defensive parse — returns null if the input isn't the expected shape. */
export function parseAskInput(input: unknown): AskQuestion[] | null {
  if (input == null || typeof input !== "object") return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of questions) {
    if (q == null || typeof q !== "object") return null;
    const obj = q as Record<string, unknown>;
    if (typeof obj.question !== "string" || !Array.isArray(obj.options))
      return null;
    const options: AskQuestion["options"] = [];
    for (const o of obj.options) {
      if (o == null || typeof o !== "object") return null;
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== "string") return null;
      options.push({
        label: opt.label,
        description:
          typeof opt.description === "string" ? opt.description : undefined,
      });
    }
    if (options.length === 0) return null;
    out.push({
      question: obj.question,
      header: typeof obj.header === "string" ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    });
  }
  return out;
}

interface Props {
  questions: AskQuestion[];
  /** The tool_result output once answered (transcript truth), else undefined. */
  resultText?: string;
  /** Clickable options need a live terminal AND a single-choice question. */
  canAnswer: boolean;
  /** Pick option `index` (0-based) of the (single) question. */
  onPick: (index: number) => void;
}

export function AskQuestionCard({
  questions,
  resultText,
  canAnswer,
  onPick,
}: Props) {
  const answered = resultText !== undefined;
  // Keystroke-driving is only well-defined for one single-select question;
  // multi-question / multi-select prompts must be answered in the terminal.
  const interactive =
    !answered &&
    canAnswer &&
    questions.length === 1 &&
    !questions[0].multiSelect;

  return (
    <div className="rounded-md border border-[var(--accent)]/40 bg-[var(--bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]">
        <span>❓</span>
        <span>
          {questions.length === 1 && questions[0].header
            ? questions[0].header
            : "Question"}
        </span>
        {!answered && (
          <span className="text-[var(--text-tertiary)]">— awaiting answer</span>
        )}
      </div>
      <div className="flex flex-col gap-3 px-3 py-2.5">
        {questions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-1.5">
            <div className="text-[13px] leading-relaxed text-[var(--text)]">
              {q.question}
            </div>
            <div className="flex flex-col gap-1">
              {q.options.map((opt, oi) => (
                <button
                  key={oi}
                  disabled={!interactive}
                  onClick={interactive ? () => onPick(oi) : undefined}
                  title={
                    interactive
                      ? "Answer in the session"
                      : answered
                        ? undefined
                        : "Answer in the terminal (⌘J)"
                  }
                  className={`rounded-md border border-[var(--border)] px-2.5 py-1.5 text-left text-[12px] leading-snug text-[var(--text-secondary)] ${
                    interactive
                      ? "cursor-pointer transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                      : "opacity-80"
                  }`}
                >
                  <span className="font-medium text-[var(--text)]">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">
                      {opt.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
        {answered && (
          <div className="border-t border-[var(--border)] pt-2">
            <div className="mb-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
              answer
            </div>
            <pre className="max-h-[200px] select-text overflow-auto whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {resultText}
            </pre>
          </div>
        )}
        {!answered && !interactive && (
          <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {questions.length > 1 || questions[0]?.multiSelect
              ? "Multi-part question — answer it in the terminal (⌘J)."
              : "Start the session terminal to answer from here."}
          </div>
        )}
      </div>
    </div>
  );
}
