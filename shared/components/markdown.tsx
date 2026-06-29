import { isValidElement, memo, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  highlightToHtml,
  stripComments,
  useActiveShikiTheme,
  useShikiReady,
} from "../lib/highlight";
import { cn } from "../lib/utils";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

/** Pull the raw code text out of react-markdown's <code> child node. */
function codeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(codeText).join("");
  return "";
}

/**
 * A fenced code block: a header strip showing the language (left) and a
 * hover-revealed copy button (right), over syntax-highlighted code.
 *
 * Two deliberate constraints keep this safe inside chat/plan surfaces, which
 * compute annotation + find offsets over the block's `textContent`:
 *  - The language label is a CSS `::before` pseudo-element (see `data-lang`),
 *    not a real text node, so it never shifts those offsets.
 *  - The copy button is icon-only (no text node) for the same reason.
 * Syntax highlighting only wraps existing characters in <span>s, so the code's
 * `textContent` is byte-identical to the plain text — offsets are unaffected.
 */
function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLine, setCopiedLine] = useState(false);
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();

  // react-markdown nests the fenced text in a <code class="language-xxx">.
  const codeEl = isValidElement(children) ? children : null;
  const codeProps = (codeEl?.props ?? {}) as {
    className?: string;
    children?: ReactNode;
  };
  const lang =
    /language-(\S+)/.exec(codeProps.className ?? "")?.[1]?.toLowerCase() ?? "";
  const code = codeText(codeProps.children);

  const html = useMemo(
    () => highlightToHtml(code, lang),
    // Re-render once shiki finishes loading, and re-tokenize on theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang, shikiReady, shikiTheme],
  );

  const copy = () => {
    const text = ref.current?.textContent ?? "";
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
    const text = ref.current?.textContent ?? "";
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
      <pre
        ref={ref}
        className="overflow-x-auto px-3 py-2.5 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed"
      >
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
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
        "text-[13.5px] leading-relaxed text-[var(--text)] [word-break:break-word]",
        className,
      )}
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
    <p className={cn("my-2 first:mt-0 last:mb-0", className)} {...p} />
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
    <ul className={cn("my-2 list-disc space-y-1 pl-5", className)} {...p} />
  ),
  ol: ({ className, ...p }: Props<"ol">) => (
    <ol className={cn("my-2 list-decimal space-y-1 pl-5", className)} {...p} />
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
          "rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 font-[family-name:var(--font-mono)] text-[0.88em]",
          className,
        )}
        {...p}
      />
    );
  },
  table: ({ className, ...p }: Props<"table">) => (
    <div className="my-2 overflow-x-auto">
      <table
        className={cn(
          "w-full border-collapse text-[12px] [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
          className,
        )}
        {...p}
      />
    </div>
  ),
};
