"use client";

import { useEffect, useState } from "react";
import type { Highlighter } from "shiki";
import type { ThemeDefinition } from "./themes";

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

const DEFAULT_THEME = "github-dark";

/**
 * Files at or below this many characters are tokenized synchronously on the
 * render that opens them, so they appear colored on first paint with no flash
 * of plain text — and without slowing the open, because at this size
 * tokenization stays under one frame (~10ms for ~300 lines of heavy TSX, the
 * worst-case grammar; benchmarked). Larger files would block the open render
 * noticeably (a 50k-char file is ~100ms), so they instead defer: paint plain
 * immediately, color on a follow-up low-priority render. That keeps the open
 * itself instant at every size — the only difference is whether colors land on
 * the first paint (small files) or the very next one (large files).
 */
export const SYNC_HIGHLIGHT_MAX_CHARS = 10_000;

/**
 * Syntax themes available to the highlighter, derived from the UI themes the
 * app registers (see `registerShikiThemes`). A theme's `syntax` is either a
 * bundled shiki name (loaded by string) or a full VS Code theme object (loaded
 * verbatim, registered under its `name`). The default pair is always present so
 * tokenization works before any UI theme registers.
 */
const bundledNames = new Set<string>([DEFAULT_THEME, "github-light"]);
const customThemes = new Map<string, object>();

/**
 * Record the syntax themes carried by the app's UI themes. Called during the
 * ThemeProvider's render, before any code block asks shiki to tokenize. Must
 * run before `ensureHighlighter` creates the (single, cached) highlighter — any
 * theme registered afterwards won't be loaded into it.
 */
export function registerShikiThemes(themes: ThemeDefinition[]): void {
  for (const t of themes) {
    if (typeof t.syntax === "string") bundledNames.add(t.syntax);
    else customThemes.set(t.syntax.name, t.syntax);
  }
}

function knownThemeName(name: string): boolean {
  return bundledNames.has(name) || customThemes.has(name);
}

/**
 * The shiki theme tokens are currently colored with. Driven by the active UI
 * theme — `applyTheme` in theme-provider calls `setActiveShikiTheme`. We bake a
 * single color per token (not a light+dark pair) and re-tokenize when this
 * changes, so each UI theme can carry its own, arbitrary syntax theme.
 */
let activeShikiTheme: string = DEFAULT_THEME;

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
        themes: [...bundledNames, ...customThemes.values()] as never,
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
 * Point tokenization at a different shiki theme. Called by the theme provider
 * when the UI theme changes. Notifies subscribers so mounted code blocks
 * re-tokenize with the new theme's colors. Unknown names fall back to the
 * default so a misconfigured mapping never leaves code uncolored.
 */
export function setActiveShikiTheme(name: string): void {
  const next = knownThemeName(name) ? name : DEFAULT_THEME;
  if (next === activeShikiTheme) return;
  activeShikiTheme = next;
  for (const cb of subscribers) cb();
}

/**
 * The active shiki theme name, kept in React state so a component re-renders
 * (and its highlight memo re-runs) when the UI theme changes. Use the returned
 * value as a memo dependency wherever tokens are computed.
 */
export function useActiveShikiTheme(): string {
  const [name, setName] = useState<string>(activeShikiTheme);
  useEffect(() => {
    const cb = () => setName(activeShikiTheme);
    subscribers.add(cb);
    cb();
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return name;
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
  /** Color from the active shiki theme. */
  color?: string;
  italic?: boolean;
  bold?: boolean;
}

// Shiki fontStyle bit flags
const FS_ITALIC = 1;
const FS_BOLD = 2;

/**
 * Synchronously highlight a code string and return flat tokens with
 * character-offset ranges, in source order. Returns [] when shiki isn't
 * ready, the language is unsupported, or highlighting throws. There is no
 * size cap — whether code is colored depends only on language support, never
 * on how large the file is. Tokenization is a synchronous main-thread cost, so
 * very large inputs may briefly cost responsiveness in exchange for color.
 */
export function highlightTokens(
  code: string,
  languageId: string,
): SyntaxToken[] {
  if (!highlighter) return [];
  const lang = resolveLang(languageId);
  if (!lang) return [];

  let lines;
  try {
    ({ tokens: lines } = highlighter.codeToTokens(code, {
      theme: activeShikiTheme,
      includeExplanation: false,
      // Same union-type-avoidance dance as above.
      lang: lang as unknown as never,
    }));
  } catch {
    return [];
  }

  const out: SyntaxToken[] = [];
  let offset = 0;

  for (const line of lines) {
    for (const tok of line) {
      const len = tok.content.length;
      if (len === 0) continue;
      const fs = tok.fontStyle ?? 0;
      out.push({
        start: offset,
        end: offset + len,
        color: tok.color,
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

/**
 * Return `code` with comment tokens removed, using shiki's scope analysis so a
 * marker inside a string or URL (`"https://…"`, `'--not a comment'`, `"# x"`)
 * is never mistaken for a comment. Works for any supported language without
 * per-language comment-syntax rules — the grammar already knows what a comment
 * is. Lines that were pure comment become empty (callers drop them when
 * joining); inline comments leave their code prefix intact.
 *
 * Returns null when shiki isn't ready or the language is unsupported, so
 * callers can fall back to the original text rather than falsely imply the
 * comments were stripped.
 */
export function stripComments(code: string, languageId: string): string | null {
  if (!highlighter) return null;
  const lang = resolveLang(languageId);
  if (!lang) return null;

  let lines;
  try {
    ({ tokens: lines } = highlighter.codeToTokens(code, {
      theme: activeShikiTheme,
      // Scope-only explanation is the cheap path — we only need scope names,
      // not the full theme-match reasoning behind each token's color.
      includeExplanation: "scopeName",
      lang: lang as unknown as never,
    }));
  } catch {
    return null;
  }

  const out: string[] = [];
  for (const line of lines) {
    let text = "";
    for (const tok of line) {
      const isComment = tok.explanation?.some((e) =>
        e.scopes.some((s) => s.scopeName.startsWith("comment")),
      );
      if (!isComment) text += tok.content;
    }
    out.push(text);
  }
  return out.join("\n");
}

/** A real (code, not string/comment/regex) bracket character and its position. */
export interface BracketPos {
  /** 0-based line index. */
  line: number;
  /** 0-based column within the line. */
  col: number;
  /** One of ( ) [ ] { } */
  char: string;
}

const BRACKET_CHARS = "()[]{}";

/**
 * True when a token span's innermost TextMate scope is plain code — not a
 * string body, comment, or regex. A bracket in such a span is real syntax. This
 * is how VS Code classifies brackets for colorization; the innermost scope is
 * the precise signal (e.g. a `[` inside `${ … }` has innermost `meta.brace…`
 * even though `string.template` sits higher in its stack).
 */
function isCodeScope(innermost: string): boolean {
  return !(
    innermost.startsWith("string") ||
    innermost.startsWith("comment") ||
    innermost.includes("regex")
  );
}

/**
 * Positions of every *real code* bracket, using Shiki's TextMate scopes to
 * exclude brackets inside strings, comments, and regex literals — and to
 * correctly include the braces of template interpolations (`${ … }`), whose
 * contents are code. This is the principled basis for bracket-pair colorization:
 * it never string-matches the source. Returns [] when shiki isn't ready or the
 * language is unsupported.
 */
export function codeBracketPositions(
  code: string,
  languageId: string,
): BracketPos[] {
  if (!highlighter) return [];
  const lang = resolveLang(languageId);
  if (!lang) return [];

  let lines;
  try {
    ({ tokens: lines } = highlighter.codeToTokens(code, {
      theme: activeShikiTheme,
      includeExplanation: "scopeName",
      lang: lang as unknown as never,
    }));
  } catch {
    return [];
  }

  const out: BracketPos[] = [];
  for (let line = 0; line < lines.length; line++) {
    // Track the column by summing content lengths (tokens cover the line in
    // order, no gaps) rather than trusting any per-token offset field.
    let col = 0;
    for (const tok of lines[line]) {
      const spans = tok.explanation ?? [{ content: tok.content, scopes: [] }];
      for (const sp of spans) {
        const inner = sp.scopes.length
          ? sp.scopes[sp.scopes.length - 1].scopeName
          : "";
        const code = isCodeScope(inner);
        for (const ch of sp.content) {
          if (code && BRACKET_CHARS.includes(ch))
            out.push({ line, col, char: ch });
          col++;
        }
      }
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    if (t.color) classes.push("shiki-tok");

    const styleBits: string[] = [];
    if (t.color) styleBits.push(`--shiki-color:${t.color}`);
    if (t.italic) styleBits.push("font-style:italic");
    if (t.bold) styleBits.push("font-weight:600");

    const classAttr = classes.length
      ? ` class="${escapeAttr(classes.join(" "))}"`
      : "";
    const styleAttr = styleBits.length
      ? ` style="${escapeAttr(styleBits.join(";"))}"`
      : "";
    parts.push(
      `<span${classAttr}${styleAttr}>${escapeHtml(value.slice(t.start, t.end))}</span>`,
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
export function highlightPerLine(
  value: string,
  languageId: string,
): SyntaxToken[][] {
  const lines = value.split("\n");
  if (!resolveLang(languageId)) {
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
          color: tok.color,
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
