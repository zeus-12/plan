import {
  isValidElement,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCodeRunner } from "./code-runner";
import {
  highlightToHtmlLines,
  stripComments,
  SYNC_HIGHLIGHT_MAX_CHARS,
  useActiveShikiTheme,
  useShikiReady,
} from "../lib/syntax/highlight";
import { useDiffSettings } from "../lib/settings/settings";
import { cn } from "../lib/utils";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

// Code renders at this fixed size/line-height so a non-wrapped line is exactly
// CODE_LINE_HEIGHT tall — the gutter can then place unwrapped numbers by simple
// arithmetic and only measure when wrapping actually stacks a line into rows.
const CODE_FONT_SIZE = 12;
const CODE_LINE_HEIGHT = 20;

// Fences we're willing to hand to a shell. An unlabelled fence counts (agents
// write plenty of them for commands); `console`/`shellsession` deliberately do
// not — those carry `$ ` prompts and program output, so running them verbatim
// would execute the transcript rather than the command.
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "shellscript", "zsh"]);

/** Pull the raw code text out of react-markdown's <code> child node. */
function codeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(codeText).join("");
  return "";
}

/**
 * A fenced code block: a header strip (language label + wrap/copy buttons) over
 * syntax-highlighted code with a left-hand line-number gutter.
 *
 * Several deliberate constraints keep this safe inside chat/plan surfaces, which
 * compute annotation + find offsets over the block's `textContent`:
 *  - The language label is a CSS `::before` pseudo-element (see `data-lang`),
 *    not a real text node, so it never shifts those offsets.
 *  - The header buttons are icon-only (no text node) for the same reason.
 *  - The line-number gutter carries the annotation/find *skip* markers, so its
 *    number text contributes nothing to either offset space (and `copy` reads
 *    only the <pre>, which the gutter is a sibling of).
 *  - The code lines are split one-<span>-per-line but joined by real "\n" text
 *    nodes (see `highlightToHtmlLines`), so the <pre>'s `textContent` stays
 *    byte-identical to the plain source — offsets are unaffected.
 */
function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [copied, setCopied] = useState(false);
  const [copiedLine, setCopiedLine] = useState(false);
  const [ran, setRan] = useState(false);
  const runCommand = useCodeRunner();
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  const [settings, updateSettings] = useDiffSettings();
  const wrap = settings.lineWrap;

  // react-markdown nests the fenced text in a <code class="language-xxx">.
  const codeEl = isValidElement(children) ? children : null;
  const codeProps = (codeEl?.props ?? {}) as {
    className?: string;
    children?: ReactNode;
  };
  const lang =
    /language-(\S+)/.exec(codeProps.className ?? "")?.[1]?.toLowerCase() ?? "";
  const code = codeText(codeProps.children);

  const lineHtmls = useMemo(
    // Oversized blocks (a pasted file dump — or one still streaming in, which
    // re-runs this on every growth tick) skip tokenization and render as
    // escaped plain text: same size budget as the file/diff/scratch surfaces.
    // Within budget, tokenization is a sub-frame cost.
    () =>
      highlightToHtmlLines(
        code,
        code.length > SYNC_HIGHLIGHT_MAX_CHARS ? "plaintext" : lang,
      ),
    // Re-render once shiki finishes loading, and re-tokenize on theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang, shikiReady, shikiTheme],
  );

  // A trailing newline in the source (the usual case for a fenced block) splits
  // into a final empty line: keep its <span> so `textContent` stays exact, but
  // don't number it — it isn't a real line of code.
  const numberedCount =
    lineHtmls.length > 1 && lineHtmls[lineHtmls.length - 1] === ""
      ? lineHtmls.length - 1
      : lineHtmls.length;

  // Per-line pixel heights, needed only when wrapping stacks a long line into
  // several visual rows so the gutter number stays aligned to the line's top.
  // Unwrapped lines are exactly CODE_LINE_HEIGHT (fixed line-height above), so
  // there is nothing to measure — `null` means "use the uniform height".
  const [heights, setHeights] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    if (!wrap) {
      setHeights(null);
      return;
    }
    const measure = () => {
      const next = lineHtmls.map((_, i) => {
        // An empty line's inline span has no box (height 0); its rendered row is
        // still one line tall. Every real line is at least CODE_LINE_HEIGHT, and
        // a wrapped one is a larger multiple, so clamping up is always correct.
        const h = lineRefs.current[i]?.getBoundingClientRect().height ?? 0;
        return Math.max(h, CODE_LINE_HEIGHT);
      });
      setHeights((prev) =>
        prev &&
        prev.length === next.length &&
        prev.every((h, i) => h === next[i])
          ? prev
          : next,
      );
    };
    measure();
    const pre = preRef.current;
    if (!pre || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(pre);
    return () => ro.disconnect();
  }, [wrap, lineHtmls, shikiReady, shikiTheme]);

  const copy = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Collapse the block into a single line for terminal pasting: drop comments
  // first, then join the remaining lines with spaces. Comment removal is
  // scope-accurate (see `stripComments`) so a `//`/`#`/`--` inside a string or
  // URL is preserved; it falls back to the raw text when shiki can't tokenize
  // the language, so we never fake having stripped comments.
  const copyOneLine = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    const oneLine = (stripComments(text, lang) ?? text)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    if (!oneLine) return;
    void navigator.clipboard.writeText(oneLine);
    setCopiedLine(true);
    setTimeout(() => setCopiedLine(false), 1500);
  };

  const runnable = runCommand != null && SHELL_LANGS.has(lang);

  // Hand the block to a fresh terminal as-is, minus comments and blank lines —
  // line structure is kept, so multi-line constructs (a `for` loop, a `case`)
  // still run. An unlabelled fence is stripped with the bash grammar: the run
  // button only offers itself for shell-ish fences, so that's the language it
  // is about to be executed as, not a guess about what it might be.
  const run = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    const command = (stripComments(text, lang || "bash") ?? text)
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .join("\n");
    if (!command) return;
    runCommand?.(command);
    setRan(true);
    setTimeout(() => setRan(false), 1500);
  };

  // Gutter is border-box, so its width must cover the digits (`${digits}ch`,
  // tabular so each is exactly 1ch) PLUS its own padding — otherwise the number
  // overflows its content area and wraps (a two-line "1"/"0"). Keep the padding
  // tight; `digits` (min 2) guarantees room for two- and three-digit numbers.
  const digits = Math.max(2, String(numberedCount).length);
  const GUTTER_PAD_LEFT = 8;
  const GUTTER_PAD_RIGHT = 6;
  const gutterWidth = `calc(${digits}ch + ${GUTTER_PAD_LEFT + GUTTER_PAD_RIGHT}px)`;

  return (
    <div className="group my-2 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-surface)] py-1 pl-3 pr-1.5">
        <span
          aria-hidden
          data-lang={lang || "text"}
          className="code-lang-label select-none font-[family-name:var(--font-mono)] text-[11px] tracking-wide text-[var(--text-tertiary)]"
        />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => updateSettings({ lineWrap: !wrap })}
            aria-label={wrap ? "Disable line wrap" : "Wrap long lines"}
            aria-pressed={wrap}
            title={
              wrap ? "Wrapping on — click to scroll instead" : "Wrap long lines"
            }
            className={cn(
              // Hover-only in both states, exactly like the copy buttons. When
              // it does show, the on-state is a monochrome pill (outlined,
              // filled) rather than a loud accent color.
              "flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-all focus-visible:opacity-100 group-hover:opacity-100",
              wrap
                ? "bg-[var(--bg)] text-[var(--text)] ring-1 ring-inset ring-[var(--border)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg)] hover:text-[var(--text)]",
            )}
          >
            <WrapIcon />
          </button>
          {runnable && (
            <button
              type="button"
              onClick={run}
              aria-label={
                ran ? "Sent to a new terminal" : "Run in new terminal"
              }
              title={
                ran
                  ? "Sent to a new terminal"
                  : "Run in a new terminal for this project — strips comments, then runs it"
              }
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] opacity-0 transition-all hover:bg-[var(--bg)] hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              {ran ? <CheckIcon /> : <RunIcon />}
            </button>
          )}
          <button
            type="button"
            onClick={copyOneLine}
            aria-label={
              copiedLine
                ? "Copied as one line"
                : "Copy as one line for terminal"
            }
            title={
              copiedLine
                ? "Copied as one line"
                : "Copy as one line — strips comments and joins with spaces (paste-ready for the terminal)"
            }
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] opacity-0 transition-all hover:bg-[var(--bg)] hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100"
          >
            {copiedLine ? <CheckIcon /> : <CopyOneLineIcon />}
          </button>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] opacity-0 transition-all hover:bg-[var(--bg)] hover:text-[var(--text)] focus-visible:opacity-100 group-hover:opacity-100"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>
      {/* The scroller owns horizontal overflow so the sticky gutter can pin to
          the left while long unwrapped lines scroll under it. */}
      <div className={wrap ? "overflow-x-clip" : "overflow-x-auto"}>
        <div
          className={cn("flex", wrap ? "" : "w-max min-w-full")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: CODE_FONT_SIZE,
            lineHeight: `${CODE_LINE_HEIGHT}px`,
          }}
        >
          {/* Vertical padding lives on the gutter/code (not the flex row) so the
              gutter's own background fills right up to the header — no dark band. */}
          <div
            aria-hidden
            data-anno-skip=""
            data-find-skip=""
            className="sticky left-0 z-[1] box-border shrink-0 select-none whitespace-nowrap text-right tabular-nums text-[var(--text-tertiary)]"
            style={{
              width: gutterWidth,
              paddingLeft: GUTTER_PAD_LEFT,
              paddingRight: GUTTER_PAD_RIGHT,
              paddingTop: 10,
              paddingBottom: 10,
              background: "var(--bg-surface)",
            }}
          >
            {lineHtmls.map((_, i) =>
              i >= numberedCount ? null : (
                <div
                  key={i}
                  style={{
                    height: wrap && heights ? heights[i] : CODE_LINE_HEIGHT,
                  }}
                >
                  {i + 1}
                </div>
              ),
            )}
          </div>
          <pre
            ref={preRef}
            className={cn(
              "m-0 min-w-0 py-2.5 pl-3 pr-4",
              wrap
                ? "flex-1 whitespace-pre-wrap break-words"
                : "whitespace-pre",
            )}
          >
            <code>
              {lineHtmls.map((h, i) => (
                <span key={i}>
                  <span
                    ref={(el) => {
                      lineRefs.current[i] = el;
                    }}
                    dangerouslySetInnerHTML={{ __html: h }}
                  />
                  {i < lineHtmls.length - 1 ? "\n" : null}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}

function WrapIcon() {
  // An arrow turning back on itself over stacked lines — "wrap to next line".
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M3 12h15a3 3 0 0 1 0 6h-4" />
      <polyline points="16 16 14 18 16 20" />
      <line x1="3" y1="18" x2="10" y2="18" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CopyOneLineIcon() {
  // Two chevrons collapsing toward a single middle line — i.e. many lines → one.
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 4l5 5 5-5" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <path d="M7 20l5-5 5 5" />
    </svg>
  );
}
function RunIcon() {
  // A shell prompt: chevron over a caret line — "type this at a terminal".
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="5 7 10 12 5 17" />
      <line x1="13" y1="17" x2="19" y2="17" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Shared GitHub-flavoured markdown renderer. Themed via the app's CSS vars so
 * it drops into both the desktop chat and the web tool. Kept presentational —
 * no selection/annotation logic lives here (the chat view layers that on top).
 *
 * The rendered text is plain selectable DOM, so callers can compute character
 * offsets over `textContent` for annotation highlighting.
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "leading-[1.7] antialiased [word-break:break-word]",
        className,
      )}
      // Reading font / size / brightness are user prefs (desktop Settings),
      // delivered as `--prose-*` vars on <html>. Fallbacks keep the standalone
      // (web / unset) rendering identical to before.
      style={{
        fontFamily: "var(--prose-font, var(--font-sans))",
        fontSize: "var(--prose-size, 14px)",
        color: "var(--prose-fg, var(--text))",
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

type Props<T extends ElementType> = ComponentPropsWithoutRef<T>;

const COMPONENTS = {
  p: ({ className, ...p }: Props<"p">) => (
    <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...p} />
  ),
  h1: ({ className, ...p }: Props<"h1">) => (
    <h1
      className={cn(
        "mb-2 mt-4 text-[1.3em] font-semibold first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h2: ({ className, ...p }: Props<"h2">) => (
    <h2
      className={cn(
        "mb-2 mt-4 text-[1.15em] font-semibold first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h3: ({ className, ...p }: Props<"h3">) => (
    <h3
      className={cn(
        "mb-1 mt-3 text-[1.05em] font-semibold first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h4: ({ className, ...p }: Props<"h4">) => (
    <h4
      className={cn("mb-1 mt-3 font-semibold first:mt-0", className)}
      {...p}
    />
  ),
  ul: ({ className, ...p }: Props<"ul">) => (
    <ul className={cn("my-3 list-disc space-y-1.5 pl-5", className)} {...p} />
  ),
  ol: ({ className, ...p }: Props<"ol">) => (
    <ol
      className={cn("my-3 list-decimal space-y-1.5 pl-5", className)}
      {...p}
    />
  ),
  li: ({ className, ...p }: Props<"li">) => (
    <li className={cn("[&>ul]:my-1 [&>ol]:my-1", className)} {...p} />
  ),
  a: ({ className, ...p }: Props<"a">) => (
    <a
      className={cn(
        "text-[var(--accent)] underline underline-offset-2",
        className,
      )}
      target="_blank"
      rel="noreferrer noopener"
      {...p}
    />
  ),
  strong: ({ className, ...p }: Props<"strong">) => (
    <strong
      className={cn("font-semibold text-[var(--text)]", className)}
      {...p}
    />
  ),
  em: ({ className, ...p }: Props<"em">) => (
    <em className={cn("italic", className)} {...p} />
  ),
  blockquote: ({ className, ...p }: Props<"blockquote">) => (
    <blockquote
      className={cn(
        "my-2 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]",
        className,
      )}
      {...p}
    />
  ),
  hr: ({ className, ...p }: Props<"hr">) => (
    <hr className={cn("my-3 border-[var(--border)]", className)} {...p} />
  ),
  pre: (p: Props<"pre">) => <CodeBlock {...p} />,
  code: ({ className, ...p }: Props<"code">) => {
    // Fenced blocks carry a `language-*` class and live inside <pre> (already
    // styled); inline code gets its own chip styling.
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) return <code className={className} {...p} />;
    return (
      <code
        className={cn(
          "rounded-[5px] border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[0.85em]",
          className,
        )}
        {...p}
      />
    );
  },
  table: ({ className, ...p }: Props<"table">) => (
    <div className="my-3 overflow-x-auto">
      <table
        className={cn(
          "w-max max-w-full border-collapse text-[0.9em]",
          // The root's [word-break:break-word] (= overflow-wrap: anywhere) drops
          // every cell's min-content to one character, so auto layout crushes
          // short columns ("Severity" as "Se ve rit y"). Cells opt out; code
          // spans keep breaking so identifier columns still compress.
          "[&_td]:[word-break:normal] [&_td]:[overflow-wrap:break-word]",
          "[&_th]:[word-break:normal] [&_th]:[overflow-wrap:break-word]",
          "[&_code]:[overflow-wrap:anywhere]",
          "[&_td]:border [&_td]:border-[var(--border)] [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top",
          "[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
          className,
        )}
        {...p}
      />
    </div>
  ),
};
