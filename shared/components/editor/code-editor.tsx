"use client";

import { useMemo } from "react";
import Editor from "react-simple-code-editor";
import {
  highlightToHtml,
  SYNC_HIGHLIGHT_MAX_CHARS,
} from "../../lib/syntax/highlight";
import { useActiveShikiTheme, useShikiReady } from "../../lib/syntax/shiki";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  placeholder?: string;
  minHeight?: number | string;
  /** Cap the editor height; content beyond this scrolls. */
  maxHeight?: number | string;
  className?: string;
  textareaClassName?: string;
}

export function CodeEditor({
  value,
  onChange,
  language,
  placeholder,
  minHeight = 180,
  maxHeight,
  className,
  textareaClassName,
}: CodeEditorProps) {
  const shikiReady = useShikiReady();
  const shikiTheme = useActiveShikiTheme();
  const highlight = useMemo(
    // react-simple-code-editor re-runs this on EVERY keystroke/paste, over the
    // whole value. Shiki-tokenizing a large document each time is what made
    // pasting/typing crawl, so above the sync threshold we render plain (escaped)
    // text — passing "plaintext" short-circuits tokenization. Colors return once
    // the text drops back under the cap.
    () => (v: string) =>
      highlightToHtml(
        v,
        v.length > SYNC_HIGHLIGHT_MAX_CHARS ? "plaintext" : language,
      ),
    // Re-render once shiki finishes loading, and re-tokenize on theme change.
    [language, shikiReady, shikiTheme],
  );

  return (
    <div
      className={`overflow-auto rounded-lg border ${className ?? ""}`}
      style={{
        background: "var(--bg-surface)",
        borderColor: "var(--border)",
        minHeight,
        maxHeight,
      }}
    >
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlight}
        placeholder={placeholder}
        padding={12}
        // Round the textarea's own border-radius to match the container so its
        // native focus outline follows the rounded corners instead of cutting a
        // square across them. Keeps the browser's default outline color.
        textareaClassName={`rounded-lg ${textareaClassName ?? ""}`}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: "20px",
          minHeight,
          color: "var(--text)",
        }}
      />
    </div>
  );
}
