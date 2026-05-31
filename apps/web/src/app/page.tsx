"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { useUndoable } from "@plan/shared/lib/undoable";
import { useTheme } from "@plan/shared/components/theme-provider";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { MessageOutput } from "@plan/shared/components/message-output";
import { CodeEditor } from "@plan/shared/components/code-editor";
import { LanguageToolbar } from "@plan/shared/components/language-toolbar";
import { Button } from "@plan/shared/components/ui/button";
import { detectLanguage } from "@plan/shared/lib/highlight";
import { canFormat, formatCode } from "@plan/shared/lib/format";
import {
  decodeState,
  encodeState,
  type SharedState,
} from "@plan/shared/lib/share-url";

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

const HASH_PREFIX = "#d=";

function readHashState(): SharedState | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  return decodeState(hash.slice(HASH_PREFIX.length));
}

export default function Home() {
  const { theme, toggle } = useTheme();
  const [settings, updateSettings] = useDiffSettings();
  const {
    left: leftText,
    right: rightText,
    setLeft,
    setRight,
    setBoth,
    reset,
  } = useUndoable();

  const [language, setLanguage] = useState("auto");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [commentingEnabled, setCommentingEnabled] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  // Restore from URL hash on mount.
  useEffect(() => {
    const fromHash = readHashState();
    if (fromHash) {
      reset({ left: fromHash.left, right: fromHash.right });
      if (fromHash.language) setLanguage(fromHash.language);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLeftChange = useCallback(
    (v: string) => {
      setAnnotations([]);
      setLeft(v);
    },
    [setLeft]
  );

  const handleRightChange = useCallback(
    (v: string) => {
      setAnnotations([]);
      setRight(v);
    },
    [setRight]
  );

  const detected = useMemo(() => {
    const sample = rightText.length >= leftText.length ? rightText : leftText;
    if (!sample.trim()) return null;
    const lang = detectLanguage(sample);
    return lang === "plaintext" ? null : lang;
  }, [leftText, rightText]);

  const effectiveLanguage =
    language === "auto" ? detected ?? "plaintext" : language;

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right"
    ) => {
      setAnnotations((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          selectedText,
          startOffset,
          endOffset,
          comment,
          side,
        },
      ]);
    },
    []
  );

  const updateAnnotation = useCallback((id: string, comment: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, comment } : a))
    );
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleFormat = useCallback(async () => {
    if (!canFormat(effectiveLanguage)) return;
    const [l, r] = await Promise.all([
      leftText ? formatCode(leftText, effectiveLanguage) : Promise.resolve(null),
      rightText ? formatCode(rightText, effectiveLanguage) : Promise.resolve(null),
    ]);
    const nextLeft = l?.ok ? l.value : leftText;
    const nextRight = r?.ok ? r.value : rightText;
    if (nextLeft !== leftText || nextRight !== rightText) {
      setAnnotations([]);
      setBoth({ left: nextLeft, right: nextRight });
    }
  }, [leftText, rightText, effectiveLanguage, setBoth]);

  const handleMerge = useCallback(
    (next: { left: string; right: string }) => {
      setAnnotations([]);
      setBoth(next);
    },
    [setBoth]
  );

  const handleShare = useCallback(async () => {
    const encoded = encodeState({
      left: leftText,
      right: rightText,
      language: language === "auto" ? undefined : language,
    });
    const newHash = HASH_PREFIX + encoded;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", newHash);
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        setCopiedShare(true);
        setTimeout(() => setCopiedShare(false), 1800);
      } catch {
        // Clipboard may be blocked; URL is still updated for them to copy.
      }
    }
  }, [leftText, rightText, language]);

  const hasContent = leftText.length > 0 || rightText.length > 0;

  return (
    <div className="mx-auto min-h-screen max-w-[1800px] px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-[family-name:var(--font-mono)] text-base font-semibold tracking-tight text-[var(--text)]">
          plan
        </h1>
        <div className="flex items-center gap-2">
          <LanguageToolbar
            language={language}
            onLanguageChange={setLanguage}
            detectedLanguage={detected}
            onFormat={handleFormat}
            formatDisabled={!hasContent}
          />
          <Button
            variant={commentingEnabled ? "default" : "outline"}
            size="sm"
            onClick={() => setCommentingEnabled((v) => !v)}
            title={
              commentingEnabled
                ? "Selecting text in the diff opens a comment popover"
                : "Selection-to-comment is off"
            }
          >
            Comments {commentingEnabled ? "on" : "off"}
          </Button>
          {hasContent && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleShare}
              title="Copy a shareable URL containing both texts"
            >
              {copiedShare ? "Copied!" : "Share"}
            </Button>
          )}
          {hasContent && (
            <Button
              variant="ghost"
              onClick={() => {
                reset({ left: "", right: "" });
                setAnnotations([]);
              }}
            >
              Clear
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={toggle}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>

      {hasContent && (
        <div className="mb-5 space-y-5">
          <InteractiveDiff
            oldText={leftText}
            newText={rightText}
            settings={settings}
            onSettingsChange={updateSettings}
            language={effectiveLanguage}
            annotations={annotations}
            onAddAnnotation={commentingEnabled ? addAnnotation : undefined}
            onUpdateAnnotation={commentingEnabled ? updateAnnotation : undefined}
            onRemoveAnnotation={commentingEnabled ? removeAnnotation : undefined}
            onMergeChange={handleMerge}
          />

          {annotations.length > 0 && (
            <MessageOutput
              annotations={annotations}
              options={{
                intro: "",
                leftLabel: "the original",
                rightLabel: "the changed version",
              }}
            />
          )}
        </div>
      )}

      {/* Clear separator between the diff above and the editable inputs below. */}
      {hasContent && (
        <div className="mb-4 mt-2 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--border)]" />
          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.2em] text-[var(--text-tertiary)]">
            Inputs
          </span>
          <div className="h-px flex-1 bg-[var(--border)]" />
        </div>
      )}

      <div className="flex gap-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1.5 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text-secondary)]">
            Original
          </div>
          <CodeEditor
            value={leftText}
            onChange={handleLeftChange}
            language={effectiveLanguage}
            placeholder="Paste or type here…"
            maxHeight={420}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1.5 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text-secondary)]">
            Changed
          </div>
          <CodeEditor
            value={rightText}
            onChange={handleRightChange}
            language={effectiveLanguage}
            placeholder="Paste or type here…"
            maxHeight={420}
          />
        </div>
      </div>
    </div>
  );
}
