"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { PlanVersion } from "@/lib/store";
import { generateMessage } from "@/lib/store";

interface MessageOutputProps {
  version: PlanVersion;
  onUpdateMessage?: (message: string) => void;
}

export function MessageOutput({ version, onUpdateMessage }: MessageOutputProps) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const baseMessage = generateMessage(version);
  const message = customMessage ?? baseMessage;

  // Reset custom message when annotations change
  useEffect(() => {
    setCustomMessage(null);
    setIsEditing(false);
  }, [version.annotations.length]);

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
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="font-[family-name:var(--font-mono)] text-xs"
          style={{ color: "var(--text-tertiary)" }}
        >
          {version.annotations.length} change
          {version.annotations.length !== 1 ? "s" : ""}
          {customMessage ? " (edited)" : ""}
          {" — ready to send"}
        </span>
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
            className="rounded-md px-4 py-1.5 font-[family-name:var(--font-mono)] text-xs font-medium transition-all"
            style={{
              background: copied ? "var(--diff-add-bar)" : "var(--accent)",
              color: copied ? "#fff" : "var(--bg)",
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {isEditing ? (
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
          className="max-h-[300px] cursor-pointer overflow-y-auto whitespace-pre-wrap p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed transition-colors hover:bg-[var(--bg-surface-hover)]"
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
