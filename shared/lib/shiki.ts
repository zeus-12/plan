"use client";

import { useEffect, useState } from "react";
import type { Highlighter } from "shiki";

// We deliberately type as string[] rather than BundledLanguage[] — the latter
// is a 200-element union that triggers OOM during workspace typecheck.
const SUPPORTED_LANGS: string[] = [
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "bash",
  "shellscript",
  "html",
  "xml",
  "css",
  "scss",
  "json",
  "yaml",
  "markdown",
  "sql",
  "graphql",
];

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

// Shiki uses its own canonical language names. Map our app's ids — and the
// short forms that show up as markdown code-fence languages (```js, ```py) —
// onto those.
const LANG_ALIAS: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
};

let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter | null> | null = null;
const subscribers = new Set<() => void>();

function resolveLang(id: string): string | null {
  if (!id || id === "auto" || id === "plaintext") return null;
  const target = LANG_ALIAS[id] ?? id;
  return SUPPORTED_LANGS.includes(target) ? target : null;
}

/**
 * Lazily create a single shared highlighter. Subsequent calls return the
 * cached instance. Failures are swallowed (we just don't colorize).
 */
export async function ensureHighlighter(): Promise<Highlighter | null> {
  if (highlighter) return highlighter;
  if (highlighterPromise) return highlighterPromise;

  highlighterPromise = (async () => {
    try {
      const { createHighlighter } = await import("shiki");
      const h = await createHighlighter({
        themes: [LIGHT_THEME, DARK_THEME],
        // Cast through unknown — shiki expects a BundledLanguage[] union
        // which is a 200-element string union that blows up TS memory.
        langs: SUPPORTED_LANGS as unknown as never,
      });
      highlighter = h;
      // Wake up everyone who was waiting for tokens.
      for (const cb of subscribers) cb();
      return h;
    } catch {
      return null;
    }
  })();

  return highlighterPromise;
}

/**
 * Subscribe to shiki readiness so a component re-renders the moment the
 * highlighter finishes loading. Cheap — no React state ping if the
 * highlighter was already loaded by the time the component mounted.
 */
export function useShikiReady(): boolean {
  const [ready, setReady] = useState<boolean>(!!highlighter);
  useEffect(() => {
    if (highlighter) {
      if (!ready) setReady(true);
      return;
    }
    const cb = () => setReady(true);
    subscribers.add(cb);
    void ensureHighlighter();
    return () => {
      subscribers.delete(cb);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ready;
}

export interface SyntaxToken {
  start: number;
  end: number;
  /** Optional class name (for non-shiki fallback paths). */
  className?: string;
  lightColor?: string;
  darkColor?: string;
  italic?: boolean;
  bold?: boolean;
}

// Shiki fontStyle bit flags
const FS_ITALIC = 1;
const FS_BOLD = 2;

/**
 * Above these sizes we skip syntax highlighting entirely. Tokenization is a
 * synchronous, main-thread cost (full file, both diff sides, every keystroke
 * in the editor), so for very large inputs we trade colors for responsiveness
 * — the diff's add/remove backgrounds and word-diff still render.
 */
const MAX_HL_CHARS = 100_000;
const MAX_HL_LINES = 5_000;

export function isHighlightable(code: string): boolean {
  if (code.length > MAX_HL_CHARS) return false;
  // Counting newlines is far cheaper than split().
  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 && ++lines > MAX_HL_LINES) return false;
  }
  return true;
}

/**
 * Synchronously highlight a code string and return flat tokens with
 * character-offset ranges, in source order. Returns [] when shiki isn't
 * ready, the language is unsupported, the input is too large, or
 * highlighting throws.
 */
export function highlightTokens(code: string, languageId: string): SyntaxToken[] {
  if (!highlighter) return [];
  const lang = resolveLang(languageId);
  if (!lang) return [];
  if (!isHighlightable(code)) return [];

  let lines;
  try {
    lines = highlighter.codeToTokensWithThemes(code, {
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      // Same union-type-avoidance dance as above.
      lang: lang as unknown as never,
    });
  } catch {
    return [];
  }

  const out: SyntaxToken[] = [];
  let offset = 0;

  for (const line of lines) {
    for (const tok of line) {
      const len = tok.content.length;
      if (len === 0) continue;
      const light = (tok as { variants?: { light?: { color?: string; fontStyle?: number } } })
        .variants?.light;
      const dark = (tok as { variants?: { dark?: { color?: string; fontStyle?: number } } })
        .variants?.dark;
      const fs = light?.fontStyle ?? dark?.fontStyle ?? 0;
      out.push({
        start: offset,
        end: offset + len,
        lightColor: light?.color,
        darkColor: dark?.color,
        italic: (fs & FS_ITALIC) !== 0,
        bold: (fs & FS_BOLD) !== 0,
      });
      offset += len;
    }
    // newline between source lines
    offset += 1;
  }
  return out;
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
 * Render a code string to an HTML string of colored <span>s using shiki
 * tokens. The concatenated text content is byte-identical to `value` (tokens
 * only wrap existing characters — no characters are added or removed), so
 * callers that compute character offsets over the rendered DOM are unaffected.
 * Returns escaped plain text when shiki isn't ready or the language is
 * unsupported.
 */
export function highlightToHtml(value: string, language: string): string {
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

/**
 * Tokenize per-line. Mirrors the previous lowlight-based API so existing
 * callers (InteractiveDiff) work unchanged. Tokens that span line breaks
 * (e.g. block strings) are sliced per-line with adjusted offsets.
 */
export function highlightPerLine(value: string, languageId: string): SyntaxToken[][] {
  const lines = value.split("\n");
  if (!resolveLang(languageId) || !isHighlightable(value)) {
    return lines.map(() => []);
  }
  const tokens = highlightTokens(value, languageId);
  const perLine: SyntaxToken[][] = lines.map(() => []);

  let lineIdx = 0;
  let lineStart = 0;
  let lineEnd = lines[0]?.length ?? 0;
  let lineEndIncl = lineEnd + 1;

  for (const tok of tokens) {
    while (tok.start >= lineEndIncl && lineIdx < lines.length - 1) {
      lineIdx++;
      lineStart = lineEndIncl;
      lineEnd = lineStart + (lines[lineIdx]?.length ?? 0);
      lineEndIncl = lineEnd + 1;
    }

    let s = tok.start;
    const e = tok.end;
    while (s < e) {
      const sliceEnd = Math.min(e, lineEnd);
      if (sliceEnd > s) {
        perLine[lineIdx].push({
          start: s - lineStart,
          end: sliceEnd - lineStart,
          lightColor: tok.lightColor,
          darkColor: tok.darkColor,
          italic: tok.italic,
          bold: tok.bold,
        });
      }
      if (sliceEnd === e) break;
      if (lineIdx >= lines.length - 1) break;
      lineIdx++;
      lineStart = lineEndIncl;
      lineEnd = lineStart + (lines[lineIdx]?.length ?? 0);
      lineEndIncl = lineEnd + 1;
      s = lineStart;
    }
  }
  return perLine;
}
