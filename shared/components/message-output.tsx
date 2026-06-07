"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Annotation, MessageOptions } from "../lib/store";
import { generateMessage } from "../lib/store";

interface MessageOutputProps {
  annotations: Annotation[];
  options?: MessageOptions;
  onUpdateMessage?: (message: string) => void;
  /**
   * Prebuilt message text. When provided, it overrides the message generated
   * from `annotations` — used when the buffer is assembled from several sources
   * (e.g. diff annotations + chat annotations combined).
   */
  message?: string;
  /** Comment count for the header (defaults to `annotations.length`). */
  count?: number;
  /** When provided, renders a "Send" button that passes the current message. */
  onSend?: (message: string) => void;
  sendLabel?: string;
}

export function MessageOutput({
  annotations,
  options,
  onUpdateMessage,
  message: prebuilt,
  count,
  onSend,
  sendLabel = "Send to terminal",
}: MessageOutputProps) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const baseMessage = useMemo(
    () => prebuilt ?? generateMessage(annotations, options),
    [prebuilt, annotations, options]
  );
  const message = customMessage ?? baseMessage;
  const commentCount = count ?? annotations.length;

  // Drop a stale manual edit when the underlying buffer changes.
  useEffect(() => {
    setCustomMessage(null);
    setIsEditing(false);
  }, [baseMessage]);

  const startEditing = useCallback(() => {
    setEditText(message);
    setIsEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [message]);

  function saveEdit() {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== baseMessage) {
      setCustomMessage(trimmed);
      onUpdateMessage?.(trimmed);
    } else {
      setCustomMessage(null);
    }
    setIsEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setIsEditing(false);
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      saveEdit();
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSend() {
    if (!onSend) return;
    onSend(message);
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  }

  if (!baseMessage && !customMessage) return null;

  return (
    <div
      className="rounded-lg border"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-xs transition-opacity hover:opacity-70"
          style={{ color: "var(--text-tertiary)" }}
          title={collapsed ? "Show comments" : "Hide comments"}
        >
          <span
            className="inline-block text-[9px] transition-transform"
            style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
          >
            ▼
          </span>
          <span>
            {commentCount} comment
            {commentCount !== 1 ? "s" : ""}
            {customMessage ? " (edited)" : ""}
            {collapsed ? "" : " — ready to send"}
          </span>
        </button>
        <div className="flex items-center gap-2">
          {!isEditing && (
            <button
              onClick={startEditing}
              className="rounded-md px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors hover:opacity-70"
              style={{ color: "var(--text-tertiary)" }}
            >
              Edit
            </button>
          )}
          <button
            onClick={handleCopy}
            className="rounded-md px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs font-medium transition-all"
            style={{
              background: copied ? "var(--diff-add-bar)" : "var(--bg-surface-hover)",
              color: copied ? "#fff" : "var(--text)",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          {onSend && (
            <button
              onClick={handleSend}
              className="rounded-md px-4 py-1.5 font-[family-name:var(--font-mono)] text-xs font-medium transition-all"
              style={{
                background: sent ? "var(--diff-add-bar)" : "var(--accent)",
                color: sent ? "#fff" : "var(--bg)",
              }}
            >
              {sent ? "Sent ✓" : sendLabel}
            </button>
          )}
        </div>
      </div>

      {collapsed ? null : isEditing ? (
        <div className="p-3">
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full resize-y rounded-md border p-3 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
            style={{
              background: "var(--bg)",
              borderColor: "var(--border)",
              color: "var(--text)",
              minHeight: 120,
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span
              className="text-[10px]"
              style={{ color: "var(--text-tertiary)" }}
            >
              ⌘ Enter to save, Esc to cancel
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setIsEditing(false)}
                className="text-xs"
                style={{ color: "var(--text-tertiary)" }}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                className="rounded-md px-3 py-1 text-xs font-medium"
                style={{ background: "var(--accent)", color: "var(--bg)" }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : (
        <pre
          className="max-h-[300px] select-text cursor-pointer overflow-y-auto whitespace-pre-wrap p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed transition-colors hover:bg-[var(--bg-surface-hover)]"
          style={{ color: "var(--text)" }}
          onDoubleClick={startEditing}
          title="Double-click to edit"
        >
          {message}
        </pre>
      )}
    </div>
  );
}
