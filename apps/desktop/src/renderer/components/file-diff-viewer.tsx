import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileDiff } from "@plan/shared/lib/diff-parser";
import type { FileContents } from "../../shared-types";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff, type HunkRange } from "@plan/shared/components/interactive-diff";
import { LanguageToolbar } from "@plan/shared/components/language-toolbar";
import { Button } from "@plan/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { cn } from "@plan/shared/lib/utils";
import {
  detectLanguage,
  languageFromPath,
} from "@plan/shared/lib/highlight";
import {
  canFormat,
  formatCode,
  type FormatResult,
} from "@plan/shared/lib/format";
import {
  buildSingleHunkPatch,
  parseFileDiff,
} from "@plan/shared/lib/git-hunks";

interface Props {
  encoded: string;
  /** Repo sub-path within the project. "" for project-root repo. */
  subPath: string;
  file: FileDiff;
  /** All annotations across all files, so we can keep the aggregate copy box global. */
  annotationsByFile: Record<string, Annotation[]>;
  setAnnotationsByFile: React.Dispatch<
    React.SetStateAction<Record<string, Annotation[]>>
  >;
  isStaged: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  /** Called after a per-hunk stage/revert/unstage so the parent re-pulls git state. */
  onChanged: () => void;
  /** Promise-based confirmation (shared shadcn dialog) for destructive hunk reverts. */
  confirm: (opts: {
    title: string;
    description?: string;
    confirmLabel?: string;
  }) => Promise<boolean>;
}

interface FormattedState {
  oldText: string;
  newText: string;
  /** True if formatter actually changed anything vs. original. */
  changed: boolean;
}

export function FileDiffViewer({
  encoded,
  subPath,
  file,
  annotationsByFile,
  setAnnotationsByFile,
  isStaged,
  onStage,
  onUnstage,
  onDiscard,
  onChanged,
  confirm,
}: Props) {
  const [settings, updateSettings] = useDiffSettings();
  const [contents, setContents] = useState<FileContents | null>(null);

  // Hunks parsed from this file's git diff body — used for per-hunk staging.
  const parsedHunks = useMemo(() => parseFileDiff(file.body), [file.body]);

  /**
   * Match an InteractiveDiff change block (given as a line range) to one of
   * git's own hunks. Both derive from the same diff, so an overlap on either
   * the old- or new-line span uniquely identifies the hunk.
   */
  const findHunkIndex = useCallback(
    (range: HunkRange): number => {
      return parsedHunks.hunks.findIndex((h) => {
        const oldOverlap =
          range.oldStart != null &&
          range.oldEnd != null &&
          h.oldStart <= range.oldEnd &&
          range.oldStart <= h.oldStart + Math.max(h.oldCount, 1) - 1;
        const newOverlap =
          range.newStart != null &&
          range.newEnd != null &&
          h.newStart <= range.newEnd &&
          range.newStart <= h.newStart + Math.max(h.newCount, 1) - 1;
        return oldOverlap || newOverlap;
      });
    },
    [parsedHunks]
  );

  const applyHunk = useCallback(
    async (range: HunkRange, mode: "stage" | "unstage" | "discard") => {
      const idx = findHunkIndex(range);
      if (idx < 0) {
        console.warn("no git hunk matched range", range);
        return;
      }
      if (mode === "discard") {
        const ok = await confirm({
          title: "Revert this hunk?",
          description:
            "This permanently discards this hunk's changes from the working tree. It cannot be undone.",
          confirmLabel: "Revert hunk",
        });
        if (!ok) return;
      }
      const patch = buildSingleHunkPatch(parsedHunks, idx);
      const res = await window.electronAPI.applyPatch(
        encoded,
        patch,
        mode,
        subPath
      );
      if (!res.ok) console.warn(`${mode} hunk failed:`, res.error);
      onChanged();
    },
    [findHunkIndex, parsedHunks, encoded, subPath, onChanged, confirm]
  );

  const [language, setLanguage] = useState("auto");

  // Format toggle state: lives only in-memory; never written to disk.
  const [formatted, setFormatted] = useState<FormattedState | null>(null);
  const [formatActive, setFormatActive] = useState(false);
  const [formatPending, setFormatPending] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContents(null);
    setFormatted(null);
    setFormatActive(false);
    setFormatError(null);
    window.electronAPI
      .getFileContents(encoded, file.oldPath, file.newPath, subPath)
      .then((c) => {
        if (!cancelled) setContents(c);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded, file.oldPath, file.newPath, subPath]);

  const annotations = annotationsByFile[file.path] ?? [];

  // If the underlying old/new content changes, drop stale annotations for this
  // file — their offsets won't match the new text.
  const contentSig =
    (contents?.oldText.length ?? 0) + ":" + (contents?.newText.length ?? 0);
  useEffect(() => {
    setAnnotationsByFile((prev) => {
      if (!(file.path in prev)) return prev;
      const { [file.path]: _drop, ...rest } = prev;
      return rest;
    });
  }, [contentSig, file.path, setAnnotationsByFile]);

  const detected = useMemo(() => {
    const fromPath = languageFromPath(file.path);
    if (fromPath) return fromPath;
    if (!contents) return null;
    const sample =
      contents.newText.length >= contents.oldText.length
        ? contents.newText
        : contents.oldText;
    const guess = detectLanguage(sample);
    return guess === "plaintext" ? null : guess;
  }, [file.path, contents]);

  const effectiveLanguage =
    language === "auto" ? detected ?? "plaintext" : language;

  // Reset the formatted cache when the language changes — a previous formatting
  // is no longer relevant.
  useEffect(() => {
    setFormatted(null);
    setFormatActive(false);
    setFormatError(null);
  }, [effectiveLanguage]);

  // Source-of-truth for what's currently being shown in the diff viewer.
  // Annotations attach to offsets in this text, so line-number computation
  // must use the same source.
  const viewOldText =
    formatActive && formatted ? formatted.oldText : contents?.oldText ?? "";
  const viewNewText =
    formatActive && formatted ? formatted.newText : contents?.newText ?? "";

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right"
    ) => {
      // Compute line range from the side's source text (matches what the diff
      // viewer was actually rendering when the user made the selection).
      const sourceText = side === "left" ? viewOldText : viewNewText;
      const startLine = offsetToLine(sourceText, startOffset);
      const endLine = offsetToLine(sourceText, Math.max(startOffset, endOffset - 1));
      setAnnotationsByFile((prev) => ({
        ...prev,
        [file.path]: [
          ...(prev[file.path] ?? []),
          {
            id: crypto.randomUUID(),
            selectedText,
            startOffset,
            endOffset,
            comment,
            side,
            context: {
              filePath: file.path,
              startLine,
              endLine,
            },
          },
        ],
      }));
    },
    [file.path, setAnnotationsByFile, viewOldText, viewNewText]
  );

  const updateAnnotation = useCallback(
    (id: string, comment: string) => {
      setAnnotationsByFile((prev) => ({
        ...prev,
        [file.path]: (prev[file.path] ?? []).map((a) =>
          a.id === id ? { ...a, comment } : a
        ),
      }));
    },
    [file.path, setAnnotationsByFile]
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      setAnnotationsByFile((prev) => ({
        ...prev,
        [file.path]: (prev[file.path] ?? []).filter((a) => a.id !== id),
      }));
    },
    [file.path, setAnnotationsByFile]
  );

  const formatAvailable = canFormat(effectiveLanguage);

  const handleFormatClick = useCallback(async () => {
    if (!contents || !formatAvailable) return;
    // Already computed → just toggle the preview.
    if (formatted) {
      if (formatted.changed) setFormatActive((v) => !v);
      return;
    }
    setFormatPending(true);
    setFormatError(null);
    try {
      const noop: FormatResult = { ok: true, value: "" };
      const [l, r] = await Promise.all<FormatResult>([
        contents.oldText
          ? formatCode(contents.oldText, effectiveLanguage)
          : Promise.resolve(noop),
        contents.newText
          ? formatCode(contents.newText, effectiveLanguage)
          : Promise.resolve(noop),
      ]);
      const oldFmt = l.ok ? l.value : contents.oldText;
      const newFmt = r.ok ? r.value : contents.newText;
      const changed =
        oldFmt !== contents.oldText || newFmt !== contents.newText;
      setFormatted({ oldText: oldFmt, newText: newFmt, changed });
      setFormatActive(changed); // only switch to preview if there's something to show
      if (!l.ok || !r.ok) {
        setFormatError(l.ok ? r.ok ? null : r.error ?? "Format failed" : l.error ?? "Format failed");
      }
    } finally {
      setFormatPending(false);
    }
  }, [contents, formatAvailable, formatted, effectiveLanguage]);

  const formatTooltip = !formatAvailable
    ? `No formatter for ${effectiveLanguage}`
    : formatError
      ? formatError
      : formatted && !formatted.changed
        ? "Already formatted"
        : formatActive
          ? "Preview only · click to revert"
          : "Preview only · file isn't touched";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11px]">
          <span className="text-[var(--text-tertiary)]">
            {statusLabel(file.status)}
          </span>
          {isStaged && (
            <span className="rounded bg-[var(--diff-add-gutter)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--diff-add-bar)]">
              STAGED
            </span>
          )}
          <span className="truncate text-[var(--text-secondary)]">
            {file.path}
          </span>
          <span className="ml-2 text-[var(--diff-add-bar)]">
            +{file.additions}
          </span>
          <span className="text-[var(--diff-remove-bar)]">
            −{file.deletions}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isStaged ? (
            <Button variant="outline" size="sm" onClick={onUnstage} title="Unstage all changes for this file">
              Unstage
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onDiscard} title="Discard all unstaged changes for this file">
                Discard
              </Button>
              <Button variant="default" size="sm" onClick={onStage} title="Stage all changes for this file">
                Stage
              </Button>
            </>
          )}
          <LanguageToolbar
            language={language}
            onLanguageChange={setLanguage}
            detectedLanguage={detected}
            // Hide the Toolbar's built-in Format button — we manage it here.
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={formatActive ? "default" : "outline"}
                size="sm"
                onClick={handleFormatClick}
                disabled={
                  !contents ||
                  !formatAvailable ||
                  formatPending ||
                  (formatted !== null && !formatted.changed)
                }
                className={cn(
                  formatted &&
                    !formatted.changed &&
                    "opacity-100 ring-1 ring-[var(--accent)]"
                )}
              >
                {formatPending
                  ? "Formatting…"
                  : formatted && !formatted.changed
                    ? "Format ✓"
                    : formatActive
                      ? "Original"
                      : "Format"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{formatTooltip}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {file.binary ? (
          <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Binary file
          </div>
        ) : !contents ? (
          <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : contents.binary ? (
          <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            Binary file
          </div>
        ) : (
          <InteractiveDiff
            oldText={viewOldText}
            newText={viewNewText}
            settings={settings}
            onSettingsChange={updateSettings}
            isFirstVersion={file.status === "added"}
            language={effectiveLanguage}
            annotations={annotations}
            onAddAnnotation={addAnnotation}
            onUpdateAnnotation={updateAnnotation}
            onRemoveAnnotation={removeAnnotation}
            hunkActions={
              parsedHunks.hunks.length > 0
                ? {
                    isStaged,
                    onStage: (r) => applyHunk(r, "stage"),
                    onUnstage: (r) => applyHunk(r, "unstage"),
                    onRevert: (r) => applyHunk(r, "discard"),
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function statusLabel(s: FileDiff["status"]): string {
  switch (s) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/** 1-based line number for a character offset in `text`. */
function offsetToLine(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
