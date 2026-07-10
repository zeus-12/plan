"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

/** Key-cap hint tinted to read on the accent-colored submit button. */
function PopoverKbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded px-1 text-[10px] font-medium leading-none"
      style={{ background: "color-mix(in srgb, var(--bg) 22%, transparent)" }}
    >
      {children}
    </kbd>
  );
}

const SELECTED_TEXT_TRUNCATE_LEN = 80;
const POPOVER_WIDTH = 360;
const MIN_BOTTOM_CLEARANCE = 260;
const CLICK_OUTSIDE_DELAY_MS = 100;

interface CommentPopoverProps {
  position: { top: number; left: number };
  selectedText: string;
  initialComment?: string;
  submitLabel?: string;
  onSubmit: (comment: string) => void;
  onClose: () => void;
  onDelete?: () => void;
}

export function CommentPopover({
  position,
  selectedText,
  initialComment = "",
  submitLabel = "Comment",
  onSubmit,
  onClose,
  onDelete,
}: CommentPopoverProps) {
  const [comment, setComment] = useState(initialComment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Auto-focusing the textarea collapses the document selection the user
      // made, so a plain cmd/ctrl+C would copy the empty textarea instead of
      // the highlighted text. When the textarea has no selection of its own,
      // honour the gesture by copying the originally-selected text. If the user
      // has selected text inside the textarea, let the native copy through.
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const el = textareaRef.current;
        const hasOwnSelection =
          el != null && el.selectionStart !== el.selectionEnd;
        if (!hasOwnSelection && selectedText) {
          e.preventDefault();
          void navigator.clipboard.writeText(selectedText);
        }
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, CLICK_OUTSIDE_DELAY_MS);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, selectedText]);

  function handleSubmit() {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Stop the keystroke from also reaching the comments panel's window-level
      // ⌘↵ listener (it's armed whenever the chat composer is blurred). Without
      // this, submitting a comment would in the same stroke flush the whole
      // buffer to chat — the comment should settle in the panel first.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      handleSubmit();
    }
  }

  const truncated =
    selectedText.length > SELECTED_TEXT_TRUNCATE_LEN
      ? selectedText.slice(0, SELECTED_TEXT_TRUNCATE_LEN) + "..."
      : selectedText;

  // Clamp into the viewport — callers pass a raw anchor (below the selection /
  // annotation / caret) and placement policy lives here, in one place.
  const top = Math.max(
    8,
    Math.min(position.top, window.innerHeight - MIN_BOTTOM_CLEARANCE),
  );
  const left = Math.max(
    8,
    Math.min(position.left, window.innerWidth - POPOVER_WIDTH - 30),
  );

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 rounded-lg border shadow-xl"
      style={{
        top,
        left,
        width: POPOVER_WIDTH,
        background: "var(--popover-bg)",
        borderColor: "var(--popover-border)",
      }}
    >
      <div
        className="border-b px-3 py-2 font-[family-name:var(--font-mono)] text-xs leading-relaxed"
        style={{
          borderColor: "var(--popover-border)",
          color: "var(--text-tertiary)",
        }}
      >
        &ldquo;{truncated}&rdquo;
      </div>
      <div className="p-3">
        <textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Suggest a change..."
          rows={3}
          className="w-full resize-none rounded-md border px-3 py-2 font-[family-name:var(--font-mono)] text-sm leading-relaxed placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
          style={{
            background: "var(--bg)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {onDelete && (
              <button
                onClick={onDelete}
                className="text-[11px] transition-colors hover:opacity-70"
                style={{ color: "var(--removed-text)" }}
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1 text-xs transition-colors hover:opacity-70"
              style={{ color: "var(--text-tertiary)" }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!comment.trim()}
              className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-30"
              style={{
                background: "var(--accent)",
                color: "var(--bg)",
              }}
            >
              {submitLabel}
              <span className="flex items-center gap-0.5">
                <PopoverKbd>⌘</PopoverKbd>
                <PopoverKbd>↵</PopoverKbd>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
