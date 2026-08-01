import { useEffect, useRef, useState } from "react";
import { cn } from "@plan/shared/lib/utils";
import type { CommentListItem } from "./annotation-store";

interface Props {
  comments: CommentListItem[];
  /** The composed send-to-chat message — what the eye and copy actions show. */
  message: string;
  /** Discard every comment. Expected to confirm with the user first. */
  onClear: () => void;
  /** Jump to where a comment was made and open its popover. Called only for
   *  comments that recorded a target. */
  onOpen: (item: CommentListItem) => void;
}

/** Grace period so the list survives the gap between chip and list. */
const CLOSE_DELAY_MS = 120;

/**
 * The pending-comments buffer, as a chip above the composer: a count, a hover
 * list of every comment, and per-item jump/delete. The comments themselves live
 * on the surfaces they were made on, and they leave this buffer by being sent
 * with the next message — there's nothing to stage or flush by hand.
 */
export function CommentChip({ comments, message, onClear, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  // A click pins the list open, so reaching for an item's delete can't dismiss
  // it by leaving the chip.
  const [pinned, setPinned] = useState(false);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const cancelClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (!pinned) setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open && !raw) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (raw) setRaw(false);
      else {
        setPinned(false);
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, raw]);

  // A pinned list survives the pointer leaving, so it needs its own dismissal.
  useEffect(() => {
    if (!pinned) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return;
      setPinned(false);
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned]);

  // The buffer emptied out from under an open list (last comment deleted, or
  // the message sent) — don't leave a pinned, empty panel behind.
  useEffect(() => {
    if (comments.length === 0) {
      setOpen(false);
      setPinned(false);
    }
  }, [comments.length]);

  if (comments.length === 0) return null;

  async function copy() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const iconBtn =
    "flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]";

  return (
    <div
      ref={rootRef}
      className="relative flex w-max flex-col"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            <span>
              {comments.length} comment{comments.length !== 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setRaw(true)}
                title="View the message"
                aria-label="View the message"
                className={iconBtn}
              >
                <EyeIcon />
              </button>
              <button
                onClick={copy}
                title={copied ? "Copied" : "Copy the message"}
                aria-label="Copy the message"
                className={iconBtn}
                style={copied ? { color: "var(--diff-add-bar)" } : undefined}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
              <button
                onClick={onClear}
                title="Clear all comments"
                aria-label="Clear all comments"
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[color-mix(in_srgb,var(--removed-text)_18%,transparent)] hover:text-[var(--removed-text)]"
              >
                <TrashIcon />
              </button>
            </div>
          </div>
          <div className="max-h-[260px] overflow-y-auto">
            {comments.map((c, i) => (
              <CommentRow
                key={c.id}
                index={i}
                item={c}
                onOpen={() => {
                  setPinned(false);
                  setOpen(false);
                  onOpen(c);
                }}
              />
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => {
          setPinned((p) => !p);
          setOpen(true);
        }}
        className={cn(
          // rounded-xl matches the composer directly below it — the two sit on
          // the same 820px column, so a shared radius is what makes them read
          // as one stack rather than two unrelated boxes.
          "flex items-center gap-1.5 rounded-xl border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors",
          open
            ? "border-[var(--border-strong)] bg-[var(--bg-surface-hover)] text-[var(--text)]"
            : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]",
        )}
        title={pinned ? "Unpin the list" : "Show the comments"}
      >
        <CommentIcon />
        <span>
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </button>

      {raw && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onMouseDown={() => setRaw(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--text-tertiary)]">
                Message · {comments.length} comment
                {comments.length !== 1 ? "s" : ""}
              </span>
              <button
                onClick={() => setRaw(false)}
                aria-label="Close"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[14px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
            <pre className="min-h-0 flex-1 select-text overflow-y-auto whitespace-pre-wrap p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed text-[var(--text)]">
              {message}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  index,
  item,
  onOpen,
}: {
  index: number;
  item: CommentListItem;
  onOpen: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const canOpen = !!item.target;

  const iconBtn =
    "flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]";

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative flex gap-2.5 px-3 py-2.5",
        index > 0 && "border-t border-[var(--border)]",
        hovered && "bg-[var(--row-hover)]",
      )}
    >
      <span className="shrink-0 font-[family-name:var(--font-mono)] text-[11px] leading-[18px] text-[var(--text-tertiary)]">
        {index + 1}.
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Right padding keeps the path clear of the hover actions, which are
            positioned over this row rather than in the flow (so revealing them
            can't reflow the text under the cursor). */}
        <div
          className="truncate pr-12 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]"
          title={item.location ?? item.group}
        >
          {item.location ? shortLocation(item.location) : item.group}
        </div>
        <div className="line-clamp-2 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.5] text-[var(--text-secondary)]">
          {item.selectedText}
        </div>
        <div className="font-[family-name:var(--font-mono)] text-[12px] leading-[1.5] text-[var(--text)]">
          {item.comment}
        </div>
      </div>
      {hovered && (
        <div className="absolute right-2.5 top-2 flex items-center gap-0.5">
          {canOpen && (
            <button
              onClick={onOpen}
              title="Go to this comment"
              aria-label="Go to this comment"
              className={iconBtn}
            >
              <PencilIcon />
            </button>
          )}
          <button
            onClick={item.remove}
            title="Delete this comment"
            aria-label="Delete this comment"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[color-mix(in_srgb,var(--removed-text)_18%,transparent)] hover:text-[var(--removed-text)]"
          >
            <XIcon />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * `apps/desktop/src/renderer/components/x.tsx:L58` → `…/components/x.tsx:L58`.
 * The list is 420px wide and the filename plus line are what identify a comment,
 * so the leading directories go rather than the tail being cut off.
 */
function shortLocation(location: string): string {
  const cut = location.lastIndexOf(":L");
  const path = cut > 0 ? location.slice(0, cut) : location;
  const lines = cut > 0 ? location.slice(cut) : "";
  const parts = path.split("/");
  if (parts.length <= 2) return location;
  return `…/${parts.slice(-2).join("/")}${lines}`;
}

/** Inline icons (Lucide path data), matching the hand-rolled set in
 *  `message-output.tsx` — `shared/` and the renderer stay icon-library free. */
function Icon({
  size = 13,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function CommentIcon() {
  return (
    <Icon size={12}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

function XIcon() {
  return (
    <Icon size={12}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  );
}

function PencilIcon() {
  return (
    <Icon>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.986L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z" />
      <path d="m15 5 4 4" />
    </Icon>
  );
}

function EyeIcon() {
  return (
    <Icon>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function CopyIcon() {
  return (
    <Icon>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

function CheckIcon() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}
