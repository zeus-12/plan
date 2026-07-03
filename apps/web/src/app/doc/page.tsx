"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTheme } from "@plan/shared/components/theme-provider";
import { CodeEditor } from "@plan/shared/components/code-editor";
import { LanguageToolbar } from "@plan/shared/components/language-toolbar";
import { DocView } from "@plan/shared/components/doc-view";
import { SettingsPopover } from "@plan/shared/components/settings-popover";
import { Button } from "@plan/shared/components/ui/button";
import { detectLanguage } from "@plan/shared/lib/highlight";
import { FONT_SIZE_OPTIONS, type FontSize } from "@plan/shared/lib/settings";
import { useDocSettings } from "@plan/shared/lib/doc-settings";
import {
  decodeDocState,
  encodeDocState,
  type DocComment,
  type DocState,
} from "@plan/shared/lib/doc-share-url";
import { SectionNav } from "@/components/section-nav";

const HASH_PREFIX = "#c=";
const AUTHOR_KEY = "plan-doc-author";

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/** Small key-cap hint shown inside a button (tinted for the accent bg). */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded px-1 text-[10px] font-medium leading-none"
      style={{ background: "color-mix(in srgb, var(--bg) 22%, transparent)" }}
    >
      {children}
    </kbd>
  );
}

function readHashState(): DocState | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodeDocState(hash.slice(HASH_PREFIX.length));
}

function formatWhen(ms?: number): string {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(ms);
  } catch {
    return "";
  }
}

export default function DocPage() {
  const { isDark, toggle } = useTheme();

  const [mode, setMode] = useState<"compose" | "view">("compose");
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("auto");
  const [comments, setComments] = useState<DocComment[]>([]);
  const [author, setAuthor] = useState("");
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [docSettings, updateDocSettings] = useDocSettings();

  // Restore from the URL hash on mount.
  useEffect(() => {
    const fromHash = readHashState();
    if (fromHash) {
      setText(fromHash.text);
      setLanguage(fromHash.language ?? "auto");
      setComments(fromHash.comments);
      setMode("view");
    }
    if (typeof window !== "undefined") {
      setAuthor(window.localStorage.getItem(AUTHOR_KEY) ?? "");
    }
  }, []);

  const detected = useMemo(() => {
    if (!text.trim()) return null;
    // Strict: don't let lowlight guess prose/plain text into a code language
    // (it mislabels arbitrary text as e.g. CSS, coloring stray letters). Real
    // code still trips the high-confidence heuristics; anything else stays
    // plain, and the user can pick a language from the dropdown.
    const lang = detectLanguage(text, { useLowlightFallback: false });
    return lang === "plaintext" ? null : lang;
  }, [text]);

  const effectiveLanguage =
    language === "auto" ? (detected ?? "plaintext") : language;

  // Keep the URL hash in sync with the doc while viewing, so a refresh (or
  // copying the address bar) never loses comments.
  useEffect(() => {
    if (mode !== "view" || typeof window === "undefined") return;
    const encoded = encodeDocState({
      text,
      language: language === "auto" ? undefined : language,
      comments,
    });
    window.history.replaceState(null, "", HASH_PREFIX + encoded);
  }, [mode, text, language, comments]);

  const handleAuthorChange = useCallback((v: string) => {
    setAuthor(v);
    if (typeof window !== "undefined")
      window.localStorage.setItem(AUTHOR_KEY, v);
  }, []);

  const addComment = useCallback(
    (start: number, end: number, quote: string, body: string) => {
      setComments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          start,
          end,
          quote,
          body,
          author: author.trim() || undefined,
          createdAt: Date.now(),
        },
      ]);
    },
    [author],
  );

  const removeComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleShare = useCallback(async () => {
    if (typeof window === "undefined") return;
    const encoded = encodeDocState({
      text,
      language: language === "auto" ? undefined : language,
      comments,
    });
    window.history.replaceState(null, "", HASH_PREFIX + encoded);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be blocked; the address bar is updated regardless.
    }
  }, [text, language, comments]);

  const handleCopyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1800);
    } catch {
      // Clipboard may be blocked.
    }
  }, [text]);

  const createDoc = useCallback(() => {
    if (text.trim()) setMode("view");
  }, [text]);

  // ⌘/Ctrl+Enter creates the doc from the compose screen.
  useEffect(() => {
    if (mode !== "compose") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        createDoc();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, createDoc]);

  const startNew = useCallback(() => {
    setMode("compose");
    setText("");
    setComments([]);
    setLanguage("auto");
    setActiveCommentId(null);
    if (typeof window !== "undefined")
      window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const sortedComments = useMemo(
    () => [...comments].sort((a, b) => a.start - b.start),
    [comments],
  );

  const hasContent = text.trim().length > 0;

  return (
    <div className="mx-auto min-h-screen max-w-[1800px] px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-[family-name:var(--font-mono)] text-base font-semibold tracking-tight text-[var(--text)]">
            plan
          </h1>
          <SectionNav current="doc" />
        </div>
        <div className="flex items-center gap-2">
          <LanguageToolbar
            language={language}
            onLanguageChange={setLanguage}
            detectedLanguage={detected}
          />
          {mode === "view" && (
            <SettingsPopover
              title="Doc settings"
              rows={[
                {
                  label: "Font size",
                  control: (
                    <select
                      value={docSettings.fontSize}
                      onChange={(e) =>
                        updateDocSettings({
                          fontSize: Number(e.target.value) as FontSize,
                        })
                      }
                      className="cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-transparent px-2 py-1 pr-5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
                      style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
                        backgroundRepeat: "no-repeat",
                        backgroundPosition: "right 4px center",
                      }}
                    >
                      {FONT_SIZE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}px
                        </option>
                      ))}
                    </select>
                  ),
                },
                {
                  label: "Wrap",
                  control: (
                    <button
                      onClick={() =>
                        updateDocSettings({ lineWrap: !docSettings.lineWrap })
                      }
                      className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
                        docSettings.lineWrap
                          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)]"
                      }`}
                    >
                      Line wrap
                    </button>
                  ),
                },
              ]}
            />
          )}
          {mode === "view" && (
            <input
              value={author}
              onChange={(e) => handleAuthorChange(e.target.value)}
              placeholder="Your name"
              className="h-6 w-28 rounded-md border bg-transparent px-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
              style={{ borderColor: "var(--border)" }}
              title="Comments you add are attributed to this name"
            />
          )}
          {mode === "compose" ? (
            <Button size="sm" onClick={createDoc} disabled={!hasContent}>
              Create doc
              <span className="ml-1 flex items-center gap-0.5">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </span>
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleCopyText}>
                {copiedText ? "Copied!" : "Copy text"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleShare}>
                {copied ? "Link copied!" : "Share"}
              </Button>
              <Button variant="ghost" size="sm" onClick={startNew}>
                New
              </Button>
            </>
          )}
          <Button variant="outline" size="icon" onClick={toggle}>
            {isDark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>

      {mode === "compose" ? (
        <div className="flex flex-col gap-2">
          <CodeEditor
            value={text}
            onChange={setText}
            language={effectiveLanguage}
            placeholder="Paste or type the document you want to share for comments…"
            minHeight={320}
            maxHeight={560}
          />
        </div>
      ) : (
        <div className="flex max-w-[1400px] gap-4">
          <div className="min-w-0 flex-1">
            <DocView
              text={text}
              language={effectiveLanguage}
              comments={comments}
              onAddComment={addComment}
              onRemoveComment={removeComment}
              activeCommentId={activeCommentId}
              onActiveCommentChange={setActiveCommentId}
              fontSize={docSettings.fontSize}
              lineWrap={docSettings.lineWrap}
            />
          </div>

          <aside className="w-[320px] shrink-0">
            <div className="mb-2 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text-secondary)]">
              Comments {comments.length > 0 && `(${comments.length})`}
            </div>
            {sortedComments.length === 0 ? (
              <div
                className="rounded-lg border border-dashed p-4 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
                style={{ borderColor: "var(--border)" }}
              >
                No comments yet. Select text in the document to add one.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {sortedComments.map((c) => (
                  <li
                    key={c.id}
                    onMouseEnter={() => setActiveCommentId(c.id)}
                    onMouseLeave={() => setActiveCommentId(null)}
                    className="rounded-lg border p-3 transition-colors"
                    style={{
                      borderColor:
                        activeCommentId === c.id
                          ? "var(--border-strong)"
                          : "var(--border)",
                      background:
                        activeCommentId === c.id
                          ? "var(--bg-surface-hover)"
                          : "var(--bg-surface)",
                    }}
                  >
                    <div
                      className="mb-1.5 truncate border-l-2 pl-2 font-[family-name:var(--font-mono)] text-[11px]"
                      style={{
                        borderColor: "var(--accent)",
                        color: "var(--text-tertiary)",
                      }}
                      title={c.quote}
                    >
                      {c.quote || "(empty selection)"}
                    </div>
                    <div className="whitespace-pre-wrap font-[family-name:var(--font-mono)] text-[13px] text-[var(--text)]">
                      {c.body}
                    </div>
                    <div className="mt-2 flex items-center justify-between font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                      <span>
                        {c.author || "Anonymous"}
                        {c.createdAt ? ` · ${formatWhen(c.createdAt)}` : ""}
                      </span>
                      <button
                        onClick={() => removeComment(c.id)}
                        className="transition-colors hover:opacity-70"
                        style={{ color: "var(--removed-text)" }}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
