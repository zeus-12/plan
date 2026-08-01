import { memo, useCallback, useRef } from "react";
import type { PrComment } from "@/common/shared-types";
import { Markdown } from "@plan/shared/components/markdown";
import { CommentPopover } from "@plan/shared/components/comment-popover";
import { useCommentSelection } from "@plan/shared/lib/comments/use-comment-selection";
import { cn } from "@plan/shared/lib/utils";

/** The PR description, from the (fast) meta section. */
export interface PrDescription {
  author: string;
  authorIsBot: boolean;
  createdAt: string;
  body: string;
}

interface Props {
  /** The PR description; null until the meta section lands. */
  description: PrDescription | null;
  descriptionLoading: boolean;
  descriptionError: string | null;
  /** The conversation timeline; null until the conversation section lands. */
  timeline: PrComment[] | null;
  timelineLoading: boolean;
  timelineError: string | null;
  /** False while the Conversation sub-tab is hidden — gates text selection. */
  active: boolean;
  /** Persist a note taken by selecting text somewhere in the conversation.
   * `label` is the human anchor ("description", "@vercel's comment", …). */
  onAdd: (label: string, selectedText: string, comment: string) => void;
  /** Shown in the comment popover's source pill. */
  prNumber: number;
}

/**
 * The unified conversation timeline: PR description, then every comment, review,
 * and inline review comment in one chronological stream — the same card shape
 * for all four, so a bot's line-by-line note and a human's top-level comment
 * read the same. Anchored (inline) comments carry their code snippet as a header
 * (GitHub hands us the `diff_hunk`), so nothing is homeless and we never have to
 * map GitHub's diff-position model onto our own.
 *
 * Selecting text anywhere here opens the same comment popover the diff uses; the
 * note lands in the shared send-to-chat batch.
 */
export const PrConversation = memo(function PrConversation({
  description,
  descriptionLoading,
  descriptionError,
  timeline,
  timelineLoading,
  timelineError,
  active,
  onAdd,
  prNumber,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const resolve = useCallback((range: Range) => {
    const container = containerRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      return null;
    }
    const text = range.toString().trim();
    if (!text) return null;
    // Nearest labelled card tells us what was selected (for the batch message).
    let node: Node | null = range.startContainer;
    let label = "the conversation";
    while (node && node !== container) {
      if (node instanceof HTMLElement && node.dataset.prLabel) {
        label = node.dataset.prLabel;
        break;
      }
      node = node.parentNode;
    }
    return { data: { label }, selectedText: text };
  }, []);

  const onCreate = useCallback(
    (data: { label: string }, selectedText: string, comment: string) => {
      onAdd(data.label, selectedText, comment);
    },
    [onAdd],
  );

  const selection = useCommentSelection<{ label: string }>({
    enabled: active,
    resolve,
    onCreate,
  });
  const pending = selection.pending;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        ref={containerRef}
        className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-4 py-4"
      >
        {/* Description — from the fast meta section, so it lands first. */}
        {description ? (
          <Card label="the PR description">
            <CardHeader
              author={description.author}
              isBot={description.authorIsBot}
              when={description.createdAt}
              trailing="opened this pull request"
            />
            <div className="px-4 pb-4 pt-1">
              {description.body.trim() ? (
                <Markdown content={description.body} />
              ) : (
                <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                  No description provided.
                </span>
              )}
            </div>
          </Card>
        ) : descriptionError ? (
          <ErrorCard>{descriptionError}</ErrorCard>
        ) : descriptionLoading ? (
          <SkeletonCard lines={2} />
        ) : null}

        {/* Timeline — from the slower paginated conversation section. */}
        {timeline ? (
          timeline.length === 0 ? (
            <div className="py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
              No comments yet.
            </div>
          ) : (
            timeline.map((c) => <TimelineCard key={c.id} comment={c} />)
          )
        ) : timelineError ? (
          <ErrorCard>{timelineError}</ErrorCard>
        ) : timelineLoading ? (
          <>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={3} />
          </>
        ) : null}
      </div>

      {pending && (
        <CommentPopover
          position={pending.position}
          selectedText={pending.selectedText}
          context={{ kind: "pr", pr: prNumber, filePath: pending.data.label }}
          submitLabel="Add note"
          onSubmit={selection.submit}
          onClose={selection.cancel}
        />
      )}
    </div>
  );
});

// Memoized: a PR's comments never change after load, so once rendered a card
// (and its Markdown) should never re-render — even as notes are added elsewhere
// or the popover opens/closes above it.
const TimelineCard = memo(function TimelineCard({
  comment,
}: {
  comment: PrComment;
}) {
  const label =
    comment.kind === "review-comment" && comment.path
      ? `@${comment.author}'s note on ${comment.path}`
      : comment.kind === "review"
        ? `@${comment.author}'s review`
        : `@${comment.author}'s comment`;

  return (
    <Card label={label}>
      <CardHeader
        author={comment.author}
        isBot={comment.authorIsBot}
        when={comment.createdAt}
        trailing={trailingFor(comment)}
        reviewState={comment.reviewState}
      />
      {comment.kind === "review-comment" && comment.path && (
        <div className="border-b border-[var(--border)] px-4 py-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {comment.path}
          {comment.line != null ? `:${comment.line}` : ""}
        </div>
      )}
      {comment.kind === "review-comment" && comment.diffHunk && (
        <DiffHunk hunk={comment.diffHunk} />
      )}
      {comment.body.trim() ? (
        <div className="px-4 pb-4 pt-2">
          <Markdown content={comment.body} />
        </div>
      ) : (
        <div className="px-4 pb-3 pt-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          {comment.reviewState
            ? reviewStateLabel(comment.reviewState)
            : "(no text)"}
        </div>
      )}
    </Card>
  );
});

/** A card-shaped placeholder while a section loads — same border/surface as a
 * real card, with pulsing bars standing in for the header and body. */
function SkeletonCard({ lines }: { lines: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <div className="h-3 w-24 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
        <div className="ml-auto h-2 w-16 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="h-2.5 animate-pulse rounded bg-[var(--bg-surface-hover)]"
            style={{ width: `${90 - i * 15}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function ErrorCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-pr-label={label}
      className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]"
    >
      {children}
    </div>
  );
}

function CardHeader({
  author,
  isBot,
  when,
  trailing,
  reviewState,
}: {
  author: string;
  isBot: boolean;
  when: string;
  trailing?: string;
  reviewState?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] px-4 py-2 text-[12px]">
      <span className="font-medium text-[var(--text)]">{author}</span>
      {isBot && (
        <span className="rounded bg-[var(--bg-surface-hover)] px-1 py-0.5 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
          bot
        </span>
      )}
      {reviewState && (
        <span className={cn("text-[11px]", reviewStateColor(reviewState))}>
          {reviewStateLabel(reviewState)}
        </span>
      )}
      {trailing && (
        <span className="text-[var(--text-tertiary)]">{trailing}</span>
      )}
      <span className="ml-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
        {formatWhen(when)}
      </span>
    </div>
  );
}

/** Render the small code snippet GitHub attaches to an inline comment. */
function DiffHunk({ hunk }: { hunk: string }) {
  const lines = hunk.split("\n");
  return (
    <pre className="max-h-48 overflow-auto border-b border-[var(--border)] bg-[var(--bg)] px-4 py-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre",
            line.startsWith("+") &&
              !line.startsWith("+++") &&
              "text-[var(--diff-add-bar)]",
            line.startsWith("-") &&
              !line.startsWith("---") &&
              "text-[var(--diff-remove-bar)]",
            line.startsWith("@@") && "text-[var(--text-tertiary)]",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function trailingFor(c: PrComment): string | undefined {
  if (c.kind === "review") return "reviewed";
  if (c.kind === "review-comment") return "commented on code";
  return "commented";
}

function reviewStateLabel(state: string): string {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "DISMISSED":
      return "Dismissed";
    case "COMMENTED":
      return "Commented";
    default:
      return state;
  }
}

function reviewStateColor(state: string): string {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "text-emerald-600 dark:text-emerald-400";
    case "CHANGES_REQUESTED":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-[var(--text-tertiary)]";
  }
}

/** Absolute date; PRs span weeks so "3 days ago" is less useful than the date. */
function formatWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
