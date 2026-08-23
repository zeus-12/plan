"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation } from "@plan/shared/lib/comments/store";
import { formatUnifiedDiff } from "@plan/shared/lib/diff/diff";
import { useDiffSettings } from "@plan/shared/lib/settings/settings";
import { useUndoable } from "@/features/diff/undoable";
import { InteractiveDiff } from "@plan/shared/components/diff/interactive-diff";
import { DiffSettingsControls } from "@plan/shared/components/diff/settings-controls";
import { useExpandedSeparators } from "@plan/shared/lib/diff/expanded-separators";
import { MessageOutput } from "@/features/diff/message-output";
import { CodeEditor } from "@plan/shared/components/editor/code-editor";
import { LanguageToolbar } from "@plan/shared/components/editor/language-toolbar";
import { Button } from "@plan/shared/components/ui/button";
import { detectLanguage } from "@plan/shared/lib/syntax/highlight";
import { canFormat } from "@plan/shared/lib/format";
import { formatCodeAsync } from "@/features/diff/format-async";
import {
  decodeDiffState,
  DIFF_HASH_PREFIX,
  encodeDiffState,
  type SharedDiffState,
} from "@plan/shared/lib/share/diff-share-url";
import { SectionNav } from "@/components/section-nav";
import { ThemeToggle } from "@/components/theme-toggle";

function readHashState(): SharedDiffState | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith(DIFF_HASH_PREFIX)) return null;
  return decodeDiffState(hash.slice(DIFF_HASH_PREFIX.length));
}

export default function Home() {
  const [settings, updateSettings] = useDiffSettings();
  const {
    left: leftText,
    right: rightText,
    setLeft,
    setRight,
    setBoth,
    reset,
  } = useUndoable();

  // The editors bind to the live text (instant echo), but the expensive
  // consumers — buildDiffLines + word-diff inside InteractiveDiff, and language
  // detection — run off a DEFERRED copy. Pasting a large document updates the
  // input immediately; the diff recomputes in a low-priority, interruptible
  // render instead of blocking every keystroke.
  const deferredLeft = useDeferredValue(leftText);
  const deferredRight = useDeferredValue(rightText);

  const [language, setLanguage] = useState("auto");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [commentingEnabled, setCommentingEnabled] = useState(false);
  // Share dropdown: which item was just copied (for transient feedback), and
  // whether the little menu is open.
  const [copied, setCopied] = useState<"link" | "diff" | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const separators = useExpandedSeparators();

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
    [setLeft],
  );

  const handleRightChange = useCallback(
    (v: string) => {
      setAnnotations([]);
      setRight(v);
    },
    [setRight],
  );

  const detected = useMemo(() => {
    const sample =
      deferredRight.length >= deferredLeft.length
        ? deferredRight
        : deferredLeft;
    if (!sample.trim()) return null;
    const lang = detectLanguage(sample);
    return lang === "plaintext" ? null : lang;
  }, [deferredLeft, deferredRight]);

  const effectiveLanguage =
    language === "auto" ? (detected ?? "plaintext") : language;

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right",
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
    [],
  );

  const updateAnnotation = useCallback((id: string, comment: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, comment } : a)),
    );
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleFormat = useCallback(async () => {
    if (!canFormat(effectiveLanguage)) return;
    const [l, r] = await Promise.all([
      leftText
        ? formatCodeAsync(leftText, effectiveLanguage)
        : Promise.resolve(null),
      rightText
        ? formatCodeAsync(rightText, effectiveLanguage)
        : Promise.resolve(null),
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
    [setBoth],
  );

  const flashCopied = useCallback((kind: "link" | "diff") => {
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  }, []);

  // Share link: stash the diff in the URL hash and copy the URL.
  const handleShareLink = useCallback(async () => {
    setShareOpen(false);
    const encoded = encodeDiffState({
      left: leftText,
      right: rightText,
      language: language === "auto" ? undefined : language,
    });
    const newHash = DIFF_HASH_PREFIX + encoded;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", newHash);
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        flashCopied("link");
      } catch {
        // Clipboard may be blocked; URL is still updated for them to copy.
      }
    }
  }, [leftText, rightText, language, flashCopied]);

  // Copy diff: a plain unified diff (text) to paste straight into an LLM.
  const handleCopyDiff = useCallback(async () => {
    setShareOpen(false);
    try {
      await navigator.clipboard.writeText(
        formatUnifiedDiff(leftText, rightText),
      );
      flashCopied("diff");
    } catch {
      // Clipboard blocked — nothing else we can do without a user gesture.
    }
  }, [leftText, rightText, flashCopied]);

  // Close the share menu on outside click or Escape.
  useEffect(() => {
    if (!shareOpen) return;
    const onDown = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node))
        setShareOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShareOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareOpen]);

  const hasContent = leftText.length > 0 || rightText.length > 0;

  return (
    <div className="mx-auto min-h-screen max-w-[1800px] px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-[family-name:var(--font-mono)] text-base font-semibold tracking-tight text-[var(--text)]">
            plan
          </h1>
          <SectionNav current="diff" />
        </div>
        <div className="flex items-center gap-2">
          <LanguageToolbar
            language={language}
            onLanguageChange={setLanguage}
            detectedLanguage={detected}
            onFormat={handleFormat}
            formatDisabled={!hasContent}
          />
          <DiffSettingsControls
            settings={settings}
            onSettingsChange={updateSettings}
            separators={separators}
            disabled={!hasContent}
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
            <div ref={shareRef} className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShareOpen((v) => !v)}
                title="Share this diff"
              >
                {copied === "link"
                  ? "Link copied!"
                  : copied === "diff"
                    ? "Diff copied!"
                    : "Share"}
              </Button>
              {shareOpen && (
                <div className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-surface)] py-1 shadow-md">
                  <button
                    onClick={handleShareLink}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-surface-hover)]"
                  >
                    <span className="text-[13px] text-[var(--text)]">
                      Copy share link
                    </span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                      URL with both versions embedded
                    </span>
                  </button>
                  <button
                    onClick={handleCopyDiff}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-surface-hover)]"
                  >
                    <span className="text-[13px] text-[var(--text)]">
                      Copy diff to clipboard
                    </span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                      Plain unified diff — paste into an LLM
                    </span>
                  </button>
                </div>
              )}
            </div>
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
          <ThemeToggle />
        </div>
      </header>

      {hasContent && (
        <div className="mb-5 space-y-5">
          <InteractiveDiff
            oldText={deferredLeft}
            newText={deferredRight}
            settings={settings}
            onSettingsChange={updateSettings}
            separators={separators}
            language={effectiveLanguage}
            annotations={annotations}
            onAddAnnotation={commentingEnabled ? addAnnotation : undefined}
            onUpdateAnnotation={
              commentingEnabled ? updateAnnotation : undefined
            }
            onRemoveAnnotation={
              commentingEnabled ? removeAnnotation : undefined
            }
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
