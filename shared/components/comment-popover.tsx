"use client";

import { useState, useRef, useEffect } from "react";

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
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, CLICK_OUTSIDE_DELAY_MS);
    document.addEventListener("keydown", handleEscape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  function handleSubmit() {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const truncated =
    selectedText.length > SELECTED_TEXT_TRUNCATE_LEN
      ? selectedText.slice(0, SELECTED_TEXT_TRUNCATE_LEN) + "..."
      : selectedText;

  const top = Math.min(position.top, window.innerHeight - MIN_BOTTOM_CLEARANCE);
  const left = Math.max(8, Math.min(position.left, window.innerWidth - POPOVER_WIDTH - 30));

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
            <span
              className="text-[10px]"
              style={{ color: "var(--text-tertiary)" }}
            >
              ⌘ Enter
            </span>
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
              className="rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-30"
              style={{
                background: "var(--accent)",
                color: "var(--bg)",
              }}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
