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

interface Resolution {
  /** Indices of the options that were chosen (exact-label match). */
  selected: Set<number>;
  /** Free-text the user typed via "Other" (no option matched), else null. */
  custom: string | null;
  /** False when we couldn't locate this question's answer in the result. */
  parsed: boolean;
}

/**
 * Pull this question's chosen answer out of the tool_result text. The result
 * serializes each answer as `"<question>"="<answer>"`, so we anchor on the
 * question's verbatim text and read the quoted value that follows. Returns null
 * (caller falls back to the raw result) if the marker isn't found — e.g. a
 * future wording change or a question containing a literal quote.
 */
function extractAnswer(question: string, resultText: string): string | null {
  const marker = `"${question}"="`;
  const start = resultText.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const end = resultText.indexOf('"', from);
  if (end === -1) return null;
  return resultText.slice(from, end);
}

/**
 * Map a question's answer string onto its options. Exact equality is the
 * verification: the result echoes the chosen option's label byte-for-byte, so a
 * match is certain rather than guessed. Anything that doesn't match an option is
 * treated as user-typed "Other" text and surfaced as `custom`. (Multi-select
 * answers are joined with ", " by the tool; a label that itself contains ", "
 * degrades to the custom line rather than highlighting — no info is lost.)
 */
function resolveSelection(q: AskQuestion, answer: string | null): Resolution {
  if (answer === null) return { selected: new Set(), custom: null, parsed: false };
  if (q.multiSelect) {
    const tokens = answer.split(", ").filter((t) => t.length > 0);
    const selected = new Set<number>();
    const matched = new Set<string>();
    q.options.forEach((o, i) => {
      if (tokens.includes(o.label)) {
        selected.add(i);
        matched.add(o.label);
      }
    });
    const extra = tokens.filter((t) => !matched.has(t));
    return { selected, custom: extra.length ? extra.join(", ") : null, parsed: true };
  }
  const idx = q.options.findIndex((o) => o.label === answer);
  if (idx >= 0) return { selected: new Set([idx]), custom: null, parsed: true };
  return { selected: new Set(), custom: answer, parsed: true };
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

  // Once answered, resolve each question's chosen option(s) from the result
  // (transcript truth) so we can highlight the answer in place instead of
  // restating it. We only fall back to the raw result text if NONE parsed.
  const resolutions = answered
    ? questions.map((q) => resolveSelection(q, extractAnswer(q.question, resultText!)))
    : [];
  const parsedAny = resolutions.some((r) => r.parsed);

  // Footer hint — never claims more than we know.
  const hint = answered
    ? null
    : interactive
      ? "Click an option, or answer in the terminal (⌘J)"
      : questions.length > 1 || questions[0]?.multiSelect
        ? "Multi-part question — answer it in the terminal (⌘J)"
        : "Start the session terminal to answer from here";

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--accent)]/30 bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--accent)]/5 px-3 py-2">
        <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full border border-[var(--accent)]/50 font-[family-name:var(--font-mono)] text-[10px] font-semibold leading-none text-[var(--accent)]">
          ?
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
          {questions.length === 1 && questions[0].header
            ? questions[0].header
            : "Question"}
        </span>
        <span className="ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-wide text-[var(--text-tertiary)]">
          {answered ? "answered" : "awaiting answer"}
        </span>
      </div>
      <div className="flex flex-col gap-3.5 px-3 py-3">
        {questions.map((q, qi) => {
          const res = answered ? resolutions[qi] : undefined;
          return (
            <div key={qi} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                {questions.length > 1 && (
                  <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                    {qi + 1}.
                  </span>
                )}
                <div className="text-[13px] font-medium leading-snug text-[var(--text)]">
                  {q.question}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((opt, oi) => {
                  const selected = res?.selected.has(oi) ?? false;
                  // Dim the rejected options once an answer is known — but only
                  // when we actually resolved something for this question.
                  const dimmed = !!res?.parsed && !selected;
                  return (
                    <button
                      key={oi}
                      disabled={!interactive}
                      onClick={interactive ? () => onPick(oi) : undefined}
                      className={`group flex items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        interactive
                          ? "cursor-pointer border-[var(--border)] hover:border-[var(--accent)]/60 hover:bg-[var(--bg-surface-hover)]"
                          : selected
                            ? "border-[var(--accent)]/60 bg-[var(--accent)]/[0.07]"
                            : dimmed
                              ? "border-transparent opacity-45"
                              : "border-[var(--border)]/60 opacity-90"
                      }`}
                    >
                      <span
                        className={`mt-px flex h-[17px] w-[17px] shrink-0 items-center justify-center border font-[family-name:var(--font-mono)] text-[10px] leading-none ${
                          q.multiSelect ? "rounded-[3px]" : "rounded-full"
                        } ${
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 font-semibold text-[var(--accent)]"
                            : "border-[var(--border-strong)] text-[var(--text-tertiary)]"
                        } ${
                          interactive
                            ? "transition-colors group-hover:border-[var(--accent)] group-hover:text-[var(--accent)]"
                            : ""
                        }`}
                      >
                        {selected ? "✓" : oi + 1}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={`text-[12px] leading-snug text-[var(--text)] ${
                            selected ? "font-semibold" : "font-medium"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {res?.custom && (
                  <div className="flex items-start gap-2.5 rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/[0.07] px-2.5 py-1.5">
                    <span className="mt-px flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border border-[var(--accent)] bg-[var(--accent)]/10 font-[family-name:var(--font-mono)] text-[10px] font-semibold leading-none text-[var(--accent)]">
                      ✓
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                        custom answer
                      </span>
                      <span className="select-text text-[12px] font-medium leading-snug text-[var(--text)]">
                        {res.custom}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {answered && !parsedAny && (
          <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-2.5">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
              answer
            </span>
            <p className="max-h-[200px] select-text overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {resultText}
            </p>
          </div>
        )}
      </div>
      {hint && (
        <div className="border-t border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {hint}
        </div>
      )}
    </div>
  );
}
