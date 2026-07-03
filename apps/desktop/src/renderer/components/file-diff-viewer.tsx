import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "@plan/shared/lib/diff-parser";
import type { FileView, FileImageDiff } from "../../shared-types";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import {
  InteractiveDiff,
  type HunkRange,
} from "@plan/shared/components/interactive-diff";
import { LanguageToolbar } from "@plan/shared/components/language-toolbar";
import { Button } from "@plan/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { cn } from "@plan/shared/lib/utils";
import { useWorktreeRevision } from "../lib/worktree-revision";
import { detectLanguage, languageFromPath } from "@plan/shared/lib/highlight";
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
  /** Which stage's diff to show: "staged" (HEAD↔index) or "unstaged" (index↔worktree). */
  mode: "staged" | "unstaged";
  /** False while the diffs pane is hidden — disables the global ⌘Z handler. */
  active: boolean;
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

// Memoized: many diff tabs stay mounted at once (hidden via CSS). Without this,
// any ProjectWorkspace re-render (clicking another tab, a watcher tick) would
// re-render every mounted diff — the cost that scaled with open-tab count.
export const FileDiffViewer = memo(FileDiffViewerImpl);

function FileDiffViewerImpl({
  encoded,
  subPath,
  file,
  annotationsByFile,
  setAnnotationsByFile,
  mode,
  active,
  onStage,
  onUnstage,
  onDiscard,
  onChanged,
  confirm,
}: Props) {
  const isStaged = mode === "staged";
  const [settings, updateSettings] = useDiffSettings();
  // Header slot the diff portals its settings gear into (beside "Format").
  const [settingsSlot, setSettingsSlot] = useState<HTMLDivElement | null>(null);
  const [contents, setContents] = useState<FileView | null>(null);
  // Bumped after a per-hunk op to re-fetch this file's view in place (so the
  // staged hunk leaves "Changes" immediately) without remounting the viewer.
  const [reloadKey, setReloadKey] = useState(0);
  // Bumps when the worktree changes on disk (edit/git op outside the app) so
  // the view re-fetches — treated like reloadKey: re-fetch without flashing.
  const revision = useWorktreeRevision(encoded);

  // Hunks parsed from the diff for *this stage* (staged vs unstaged) so a
  // partially-staged file shows only the relevant hunks in each section.
  const parsedHunks = useMemo(
    () => parseFileDiff(contents?.diffBody ?? ""),
    [contents?.diffBody],
  );

  // Undo stack of per-hunk ops applied in this view (⌘Z reverses them).
  const undoStack = useRef<
    { action: "stage" | "unstage" | "discard"; patch: string }[]
  >([]);

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
    [parsedHunks],
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
        subPath,
      );
      if (!res.ok) {
        console.warn(`${mode} hunk failed:`, res.error);
        return;
      }
      undoStack.current.push({ action: mode, patch });
      setReloadKey((k) => k + 1);
      onChanged();
    },
    [findHunkIndex, parsedHunks, encoded, subPath, onChanged, confirm],
  );

  // ⌘Z reverses the last per-hunk op:
  //   stage  → unstage,  unstage → stage,  discard → re-apply (forward).
  const undoLastHunk = useCallback(async () => {
    const op = undoStack.current.pop();
    if (!op) return;
    const inverse =
      op.action === "stage"
        ? "unstage"
        : op.action === "unstage"
          ? "stage"
          : "apply"; // undo a discard = forward-apply the hunk to the worktree
    const res = await window.electronAPI.applyPatch(
      encoded,
      op.patch,
      inverse,
      subPath,
    );
    if (!res.ok) console.warn("undo hunk failed:", res.error);
    setReloadKey((k) => k + 1);
    onChanged();
  }, [encoded, subPath, onChanged]);

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.key.toLowerCase() !== "z"
      )
        return;
      // Don't hijack undo inside text inputs / the terminal.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (undoStack.current.length === 0) return;
      e.preventDefault();
      void undoLastHunk();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, undoLastHunk]);

  const [language, setLanguage] = useState("auto");

  // Format toggle state: lives only in-memory; never written to disk.
  const [formatted, setFormatted] = useState<FormattedState | null>(null);
  const [formatActive, setFormatActive] = useState(false);
  const [formatPending, setFormatPending] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);

  // Clear stale content only when the file/stage actually changes — NOT on a
  // hunk-op reload, so re-fetching after "stage hunk" doesn't flash "Loading".
  useEffect(() => {
    setContents(null);
    setFormatted(null);
    setFormatActive(false);
    setFormatError(null);
  }, [encoded, file.path, mode, subPath]);

  useEffect(() => {
    // Image files render visually (ImageDiffView) — skip pulling their bytes
    // into a string here.
    if (isImagePath(file.path)) return;
    let cancelled = false;
    window.electronAPI
      .getFileView(encoded, file.path, mode, subPath)
      .then((c) => {
        if (!cancelled) setContents(c);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded, file.path, mode, subPath, reloadKey, revision]);

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
    language === "auto" ? (detected ?? "plaintext") : language;

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
    formatActive && formatted ? formatted.oldText : (contents?.oldText ?? "");
  const viewNewText =
    formatActive && formatted ? formatted.newText : (contents?.newText ?? "");

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right",
    ) => {
      // Compute line range from the side's source text (matches what the diff
      // viewer was actually rendering when the user made the selection).
      const sourceText = side === "left" ? viewOldText : viewNewText;
      const startLine = offsetToLine(sourceText, startOffset);
      const endLine = offsetToLine(
        sourceText,
        Math.max(startOffset, endOffset - 1),
      );
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
    [file.path, setAnnotationsByFile, viewOldText, viewNewText],
  );

  const updateAnnotation = useCallback(
    (id: string, comment: string) => {
      setAnnotationsByFile((prev) => ({
        ...prev,
        [file.path]: (prev[file.path] ?? []).map((a) =>
          a.id === id ? { ...a, comment } : a,
        ),
      }));
    },
    [file.path, setAnnotationsByFile],
  );

  const removeAnnotation = useCallback(
    (id: string) => {
      setAnnotationsByFile((prev) => ({
        ...prev,
        [file.path]: (prev[file.path] ?? []).filter((a) => a.id !== id),
      }));
    },
    [file.path, setAnnotationsByFile],
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
        setFormatError(
          l.ok
            ? r.ok
              ? null
              : (r.error ?? "Format failed")
            : (l.error ?? "Format failed"),
        );
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
            <Button
              variant="outline"
              size="sm"
              onClick={onUnstage}
              title="Unstage all changes for this file"
            >
              Unstage
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onDiscard}
                title="Discard all unstaged changes for this file"
              >
                Discard
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onStage}
                title="Stage all changes for this file"
              >
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
                    "opacity-100 ring-1 ring-[var(--accent)]",
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
          {/* InteractiveDiff portals its settings gear here. */}
          <div ref={setSettingsSlot} className="flex items-center" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {isImagePath(file.path) ? (
          <ImageDiffView
            encoded={encoded}
            subPath={subPath}
            path={file.path}
            status={file.status}
            mode={mode}
            cacheKey={`${revision}-${reloadKey}`}
          />
        ) : file.binary ? (
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
            settingsVariant="popover"
            settingsPortalTarget={settingsSlot}
            findEnabled={active}
            isFirstVersion={!contents.oldText}
            language={effectiveLanguage}
            annotations={annotations}
            onAddAnnotation={addAnnotation}
            onUpdateAnnotation={updateAnnotation}
            onRemoveAnnotation={removeAnnotation}
            hunkActions={
              parsedHunks.hunks.length > 0
                ? {
                    isStaged,
                    hunks: parsedHunks.hunks,
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

/** Image file types we render visually (before/after) instead of as a diff. */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
  "apng",
]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

/** Absolute local path → cache-busted `file://` URL (same approach as transcript images). */
function imageUrl(path: string, cacheKey: string): string {
  return `file://${encodeURI(path)}?v=${encodeURIComponent(cacheKey)}`;
}

function ImagePane({
  label,
  path,
  cacheKey,
}: {
  label: string;
  path: string;
  cacheKey: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
        {label}
      </div>
      {failed ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          Image unavailable
        </div>
      ) : (
        <img
          src={imageUrl(path, cacheKey)}
          alt={label}
          onError={() => setFailed(true)}
          className="max-h-[70vh] max-w-full rounded-md border border-[var(--border)] object-contain"
          style={{
            background:
              "repeating-conic-gradient(var(--bg-surface) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
          }}
        />
      )}
    </div>
  );
}

/**
 * Render an image change as its visual before/after rather than a binary code
 * diff. Sides come from the main process as readable file paths (git blobs are
 * materialized to temp files); we load them via `file://` like transcript images.
 */
function ImageDiffView({
  encoded,
  subPath,
  path,
  status,
  mode,
  cacheKey,
}: {
  encoded: string;
  subPath: string;
  path: string;
  status: FileDiff["status"];
  mode: "staged" | "unstaged";
  cacheKey: string;
}) {
  const [paths, setPaths] = useState<FileImageDiff | null>(null);

  useEffect(() => {
    setPaths(null);
  }, [encoded, path, mode, subPath]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getFileImageDiff(encoded, path, mode, subPath)
      .then((p) => {
        if (!cancelled) setPaths(p);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded, path, mode, subPath, cacheKey]);

  if (!paths) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        Loading…
      </div>
    );
  }

  const { oldPath, newPath } = paths;
  if (!oldPath && !newPath) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        Image unavailable
      </div>
    );
  }

  // A single image when only one side exists (added or deleted), otherwise a
  // before/after pair.
  const single =
    oldPath && newPath
      ? null
      : oldPath
        ? { label: status === "deleted" ? "Removed" : "Before", path: oldPath }
        : { label: status === "added" ? "Added" : "After", path: newPath! };

  return (
    <div className="flex h-full items-start justify-center gap-6 p-2">
      {single ? (
        <ImagePane
          label={single.label}
          path={single.path}
          cacheKey={cacheKey}
        />
      ) : (
        <>
          <ImagePane label="Before" path={oldPath!} cacheKey={cacheKey} />
          <ImagePane label="After" path={newPath!} cacheKey={cacheKey} />
        </>
      )}
    </div>
  );
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
