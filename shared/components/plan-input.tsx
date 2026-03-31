"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const MAX_TEXTAREA_HEIGHT = 300;

interface PlanInputProps {
  onSubmit: (text: string) => void;
  isFirstVersion: boolean;
}

export function PlanInput({ onSubmit, isFirstVersion }: PlanInputProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handlePaste() {
    setTimeout(autoResize, 0);
  }

  return (
    <div className="w-full">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={
          isFirstVersion
            ? "Paste your plan here..."
            : "Paste the updated plan here..."
        }
        rows={isFirstVersion && !text ? 6 : 3}
        className="w-full resize-none rounded-lg border px-4 py-3 font-[family-name:var(--font-mono)] text-sm leading-relaxed placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
        style={{
          background: "var(--bg-surface)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {text.trim() ? "⌘ Enter to submit" : ""}
        </span>
        <button
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: "var(--accent)",
            color: "var(--bg)",
          }}
        >
          {isFirstVersion ? "Add plan" : "Add revision"}
        </button>
      </div>
    </div>
  );
}
