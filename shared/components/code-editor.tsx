"use client";

import { useMemo } from "react";
import Editor from "react-simple-code-editor";
import { highlightTokens } from "../lib/highlight";
import { useShikiReady } from "../lib/shiki";

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

/**
 * Build the highlight HTML string the editor injects under the textarea.
 * Tokens are non-overlapping, ordered, so a single pass is enough. Shiki
 * tokens emit dual light/dark CSS variables; the global `.shiki-tok` rule
 * picks the right one based on `.dark` on the root.
 */
function highlightHTML(value: string, language: string): string {
  if (!value) return "";
  const tokens = highlightTokens(value, language);
  if (tokens.length === 0) return escapeHtml(value);

  const parts: string[] = [];
  let cur = 0;
  for (const t of tokens) {
    if (t.start > cur) parts.push(escapeHtml(value.slice(cur, t.start)));

    const classes: string[] = [];
    if (t.className) classes.push(t.className);
    if (t.lightColor || t.darkColor) classes.push("shiki-tok");

    const styleBits: string[] = [];
    if (t.lightColor) styleBits.push(`--shiki-light:${t.lightColor}`);
    if (t.darkColor) styleBits.push(`--shiki-dark:${t.darkColor}`);
    if (t.italic) styleBits.push("font-style:italic");
    if (t.bold) styleBits.push("font-weight:600");

    const classAttr = classes.length ? ` class="${escapeAttr(classes.join(" "))}"` : "";
    const styleAttr = styleBits.length ? ` style="${escapeAttr(styleBits.join(";"))}"` : "";
    parts.push(
      `<span${classAttr}${styleAttr}>${escapeHtml(value.slice(t.start, t.end))}</span>`
    );
    cur = t.end;
  }
  if (cur < value.length) parts.push(escapeHtml(value.slice(cur)));
  return parts.join("");
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
  const highlight = useMemo(
    () => (v: string) => highlightHTML(v, language),
    // Re-render once shiki finishes loading so existing content gains color.
    [language, shikiReady]
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
        textareaClassName={textareaClassName}
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
