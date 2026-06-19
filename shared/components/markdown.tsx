import { memo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import type { ComponentPropsWithoutRef, ElementType } from "react";

/**
 * A fenced code block with a copy button. The button is icon-only (no text
 * node) on purpose: this markdown renders inside chat/plan surfaces that compute
 * annotation + find offsets over `textContent`, so any stray characters here
 * would shift those offsets. Top padding reserves room so the button never
 * overlaps the code.
 */
function CodeBlock({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = ref.current?.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative my-2">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy"}
        className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] opacity-60 transition-all hover:text-[var(--text)] hover:opacity-100 group-hover:opacity-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <pre
        ref={ref}
        className={cn(
          "overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 pb-3 pt-9 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed",
          className
        )}
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        "text-[13px] leading-relaxed text-[var(--text)] [word-break:break-word]",
        className
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
        className
      )}
      {...p}
    />
  ),
  h2: ({ className, ...p }: Props<"h2">) => (
    <h2
      className={cn(
        "mb-2 mt-4 text-[1.15em] font-semibold first:mt-0",
        className
      )}
      {...p}
    />
  ),
  h3: ({ className, ...p }: Props<"h3">) => (
    <h3
      className={cn("mb-1 mt-3 text-[1.05em] font-semibold first:mt-0", className)}
      {...p}
    />
  ),
  h4: ({ className, ...p }: Props<"h4">) => (
    <h4 className={cn("mb-1 mt-3 font-semibold first:mt-0", className)} {...p} />
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
      className={cn("text-[var(--accent)] underline underline-offset-2", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...p}
    />
  ),
  strong: ({ className, ...p }: Props<"strong">) => (
    <strong className={cn("font-semibold text-[var(--text)]", className)} {...p} />
  ),
  em: ({ className, ...p }: Props<"em">) => (
    <em className={cn("italic", className)} {...p} />
  ),
  blockquote: ({ className, ...p }: Props<"blockquote">) => (
    <blockquote
      className={cn(
        "my-2 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]",
        className
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
          className
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
          className
        )}
        {...p}
      />
    </div>
  ),
};
