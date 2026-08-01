import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "@plan/shared/lib/comments/store";
import type { FileDiff } from "@plan/shared/lib/diff/diff-parser";
import type { FileView, FileImageDiff } from "@/common/shared-types";
import { useProjectAnnotations } from "@/renderer/features/comments/annotation-store";
import { useDiffSettings } from "@plan/shared/lib/settings/settings";
import { InteractiveDiff } from "@plan/shared/components/diff/interactive-diff";
import { useDiffBlame } from "@/renderer/features/git/blame/use-diff-blame";
import { LanguageToolbar } from "@plan/shared/components/editor/language-toolbar";
import { Button } from "@plan/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { cn } from "@plan/shared/lib/utils";
import { isImagePath } from "@/renderer/features/files/image-paths";
import { useWorktreeRevision } from "@/renderer/features/worktrees/worktree-revision";
import {
  detectLanguage,
  languageFromPath,
} from "@plan/shared/lib/syntax/highlight";
import {
  buildDiffLines,
  diffAnchorMatches,
  type DiffLine,
} from "@plan/shared/lib/diff/diff";
import {
  canFormat,
  formatCode,
  type FormatResult,
} from "@plan/shared/lib/format";
import {
  buildSingleHunkPatch,
  findHunkIndexForRange,
  parseFileDiff,
  type HunkRange,
} from "@plan/shared/lib/diff/git-hunks";

interface Props {
  encoded: string;
  /** Repo sub-path within the project. "" for project-root repo. */
  subPath: string;
  file: FileDiff;
  /** Which stage's diff to show: "staged" (HEAD↔index) or "unstaged" (index↔worktree). */
  mode: "staged" | "unstaged";
  /** False while the diffs pane is hidden — disables the global ⌘Z handler. */
  active: boolean;
  /** An existing comment to scroll to and open the editor on (comment chip). */
  revealAnnotation?: { id: string; nonce: number } | null;
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

const EMPTY_ANNOTATIONS: Annotation[] = [];

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
  mode,
  active,
  revealAnnotation,
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

  const applyHunk = useCallback(
    async (range: HunkRange, mode: "stage" | "unstage" | "discard") => {
      // Match the diff UI's change block back to git's own hunk (the real
      // stageable unit) — see findHunkIndexForRange in shared/lib/git-hunks.
      const idx = findHunkIndexForRange(parsedHunks.hunks, range);
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
    [parsedHunks, encoded, subPath, onChanged, confirm],
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

  // ⌥Z — toggle line wrap. Match `e.code` (not `e.key`): Option+letter emits a
  // special glyph on macOS ("Ω" for z), so the layout-independent physical code
  // is the only reliable signal.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        e.code === "KeyZ"
      ) {
        e.preventDefault();
        updateSettings({ lineWrap: !settings.lineWrap });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, settings.lineWrap, updateSettings]);

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

  const {
    annotationsByFile,
    addFileAnnotation,
    updateFileAnnotation,
    removeFileAnnotation,
  } = useProjectAnnotations(encoded);
  // Fall back to a stable constant: a fresh `[]` per render would change the
  // annotations prop's identity every time and defeat InteractiveDiff's
  // memoized row trees.
  const annotations = annotationsByFile[file.path] ?? EMPTY_ANNOTATIONS;

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

  // Comment offsets index the diff's own flat line text, so staleness is checked
  // against diff lines — one set per view the user can be looking at (raw and,
  // once computed, formatted), so toggling "Format" never invalidates a comment.
  const anchorViews = useMemo(() => {
    const views: DiffLine[][] = [];
    if (contents && !contents.binary)
      views.push(buildDiffLines(contents.oldText, contents.newText));
    if (formatted)
      views.push(buildDiffLines(formatted.oldText, formatted.newText));
    return views;
  }, [contents, formatted]);

  // Drop a comment only once we can prove its anchor is stale: the lines at its
  // offsets are no longer the lines it was made against. Nothing is pruned while
  // `contents` is null — that's "not loaded yet", not "empty file".
  useEffect(() => {
    if (anchorViews.length === 0) return;
    for (const a of annotations) {
      const anchored = anchorViews.some((dLines) =>
        diffAnchorMatches(dLines, a, a.selectedText),
      );
      if (!anchored) removeFileAnnotation(file.path, a.id);
    }
  }, [anchorViews, annotations, file.path, removeFileAnnotation]);

  /* ── Inline blame (click a row → trailing annotation + hover card) ── */

  // One blame per side via `--contents`, so authorship can't drift across
  // HEAD/index/worktree states. Skipped while the in-memory "Format" view is
  // active — that text doesn't exist in git, so any blame shown for it would
  // be a lie.
  const blameRelPath = subPath ? `${subPath}/${file.path}` : file.path;
  const blameable =
    !!contents && !contents.binary && !formatActive && !isImagePath(file.path);
  const {
    blame: diffBlame,
    card: blameCard,
    hasCard: hasBlameCard,
    closeCard: blameClose,
  } = useDiffBlame(
    encoded,
    blameRelPath,
    blameable && contents.oldText
      ? { kind: "contents", text: contents.oldText }
      : null,
    blameable && contents.newText
      ? { kind: "contents", text: contents.newText }
      : null,
  );

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right",
      startLine: number | undefined,
      endLine: number | undefined,
    ) => {
      addFileAnnotation(file.path, {
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
        // The slice key is the path alone, which can't name a tab — record the
        // repo and stage so the comment list can reopen exactly this diff.
        target: {
          kind: "diff",
          subPath,
          path: file.path,
          staged: mode === "staged",
        },
      });
    },
    [file.path, subPath, mode, addFileAnnotation],
  );

  const updateAnnotation = useCallback(
    (id: string, comment: string) =>
      updateFileAnnotation(file.path, id, comment),
    [file.path, updateFileAnnotation],
  );

  const removeAnnotation = useCallback(
    (id: string) => removeFileAnnotation(file.path, id),
    [file.path, removeFileAnnotation],
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
              className="h-7"
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
                className="h-7"
                onClick={onDiscard}
                title="Discard all unstaged changes for this file"
              >
                Discard
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-7"
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
                  "h-7",
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

      <div
        className="min-h-0 flex-1 overflow-auto p-3"
        // The blame card is fixed-position; close it when the rows scroll away.
        onScroll={hasBlameCard ? blameClose : undefined}
      >
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
          <>
            <InteractiveDiff
              commentSource={{ filePath: file.path }}
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
              revealAnnotation={revealAnnotation}
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
              blame={diffBlame}
            />
            {/* Empty tail so the last rows (and any inline comment box on them)
                can scroll up clear of the viewport's bottom edge, instead of
                being pinned there where a tall comment hides the final lines. */}
            <div aria-hidden className="h-[20vh] shrink-0" />
          </>
        )}
      </div>
      {blameCard}
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
          loading="lazy"
          decoding="async"
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
