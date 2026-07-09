import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { parseUnifiedDiff, type FileDiff } from "@plan/shared/lib/diff-parser";
import { cn } from "@plan/shared/lib/utils";
import { usePrDetail } from "../lib/pr-store";
import { useProjectAnnotations } from "../lib/annotation-store";
import { setReloadOverride } from "../lib/reload-override";
import { PrConversation } from "./pr-conversation";
import { PrFileDiff } from "./pr-file-diff";
import type { PrDetail, PrState } from "../../shared-types";

interface Props {
  encoded: string;
  subPath: string;
  number: number;
  /** False while this PR tab is hidden — gates ⌘R, ⌘F and text selection. */
  active: boolean;
}

type SubTab = "conversation" | "files" | "commits";

/** Surface key for annotations on a PR file, shared with the send-to-chat batch. */
function fileKey(subPath: string, number: number, path: string): string {
  return `${subPath}#${number}:${path}`;
}
/** Surface key for annotations taken in the conversation timeline. */
function convKey(subPath: string, number: number): string {
  return `${subPath}#${number}:conversation`;
}

/**
 * The content-pane view for one PR: a header, then Conversation / Files /
 * Commits sub-tabs. The diff reuses the shared InteractiveDiff (via PrFileDiff)
 * and the conversation reuses the shared select-to-comment machinery, so notes
 * taken anywhere here land in the same send-to-chat batch as local-diff notes.
 *
 * ⌘R force-refetches the PR (bypassing the cache) while this tab is active,
 * overriding the whole-app reload — the user asked for exactly this on any page
 * that fetches its own data.
 */
export const PrView = memo(function PrView({
  encoded,
  subPath,
  number,
  active,
}: Props) {
  const { detail, loading, revalidating, refetch } = usePrDetail(
    encoded,
    subPath,
    number,
  );
  const {
    annotationsByPr,
    addPrAnnotation,
    updatePrAnnotation,
    removePrAnnotation,
  } = useProjectAnnotations(encoded);
  const [sub, setSub] = useState<SubTab>("conversation");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // ⌘R → force refresh THIS PR (not the whole app), only while visible. Main
  // forwards ⌘R to the renderer (before-input-event) and we claim it here; the
  // claim is released when this tab is hidden, so ⌘R reloads normally elsewhere.
  useEffect(() => {
    if (!active) return;
    return setReloadOverride(() => refetch());
  }, [active, refetch]);

  const files = useMemo(
    () => (detail ? parseUnifiedDiff(detail.diff) : []),
    [detail],
  );

  // Default the Files sub-tab to the first file once the diff lands.
  useEffect(() => {
    if (selectedPath && files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(files[0]?.path ?? null);
  }, [files, selectedPath]);

  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;

  // ── Conversation annotations ──────────────────────────────────
  // Stable callbacks so the memoized PrConversation / PrFileDiff don't re-render
  // when this view re-renders for an unrelated reason (e.g. a note added on
  // another surface bumps the shared annotation store).
  const addConversationNote = useCallback(
    (label: string, selectedText: string, comment: string) => {
      addPrAnnotation(convKey(subPath, number), {
        selectedText,
        startOffset: 0,
        endOffset: selectedText.length,
        comment,
        side: "right",
        context: { filePath: `PR #${number} · ${label}` },
      });
    },
    [subPath, number, addPrAnnotation],
  );

  // ── File-diff annotations (keyed per file) ────────────────────
  const addFileNote = useCallback(
    (
      path: string,
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right",
      startLine: number,
      endLine: number,
    ) => {
      addPrAnnotation(fileKey(subPath, number, path), {
        selectedText,
        startOffset,
        endOffset,
        comment,
        side,
        context: {
          filePath: `${path} (PR #${number})`,
          startLine,
          endLine,
        },
      });
    },
    [subPath, number, addPrAnnotation],
  );
  const updateFileNote = useCallback(
    (path: string, id: string, comment: string) => {
      updatePrAnnotation(fileKey(subPath, number, path), id, comment);
    },
    [subPath, number, updatePrAnnotation],
  );
  const removeFileNote = useCallback(
    (path: string, id: string) => {
      removePrAnnotation(fileKey(subPath, number, path), id);
    },
    [subPath, number, removePrAnnotation],
  );

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        {loading ? "Loading PR…" : "No PR data."}
      </div>
    );
  }

  const error = (detail as PrDetail & { __error?: string }).__error;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-start gap-2">
          <StatePill state={detail.state} isDraft={detail.isDraft} />
          <h2 className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-[var(--text)]">
            {detail.title}{" "}
            <span className="font-[family-name:var(--font-mono)] text-[var(--text-tertiary)]">
              #{detail.number}
            </span>
          </h2>
          <button
            onClick={refetch}
            title="Refresh (⌘R)"
            aria-label="Refresh PR"
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
              revalidating && "animate-spin",
            )}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M23 4v6h-6" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
        {!error && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            <span className="truncate">
              {detail.baseRefName} <span className="opacity-60">←</span>{" "}
              {detail.headRefName}
            </span>
            <span className="text-[var(--diff-add-bar)]">
              +{detail.additions}
            </span>
            <span className="text-[var(--diff-remove-bar)]">
              −{detail.deletions}
            </span>
          </div>
        )}
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          {error}
        </div>
      ) : (
        <>
          {/* Sub-tabs */}
          <div className="flex shrink-0 items-center gap-4 border-b border-[var(--border)] px-4">
            <SubTabButton
              label="Conversation"
              active={sub === "conversation"}
              onClick={() => setSub("conversation")}
            />
            <SubTabButton
              label={`Files ${files.length}`}
              active={sub === "files"}
              onClick={() => setSub("files")}
            />
            <SubTabButton
              label={`Commits ${detail.commits.length}`}
              active={sub === "commits"}
              onClick={() => setSub("commits")}
            />
          </div>

          {/* Panes — all mounted, hidden via CSS, so scroll survives switches. */}
          <div className="relative min-h-0 flex-1">
            <div
              className={cn(
                "absolute inset-0 flex min-h-0 flex-col",
                sub !== "conversation" && "hidden",
              )}
            >
              <PrConversation
                detail={detail}
                active={active && sub === "conversation"}
                onAdd={addConversationNote}
              />
            </div>

            <div
              className={cn(
                "absolute inset-0 flex min-h-0",
                sub !== "files" && "hidden",
              )}
            >
              {files.length === 0 ? (
                <div className="flex flex-1 items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                  No file changes.
                </div>
              ) : (
                <>
                  <FileRail
                    files={files}
                    selected={selectedPath}
                    onSelect={setSelectedPath}
                  />
                  <div className="min-h-0 min-w-0 flex-1">
                    {selectedFile && (
                      <PrFileDiff
                        key={selectedFile.path}
                        encoded={encoded}
                        subPath={subPath}
                        file={selectedFile}
                        headSha={detail.headSha}
                        annotations={
                          annotationsByPr[
                            fileKey(subPath, number, selectedFile.path)
                          ] ?? EMPTY
                        }
                        onAdd={(text, start, end, comment, side, sl, el) =>
                          addFileNote(
                            selectedFile.path,
                            text,
                            start,
                            end,
                            comment,
                            side,
                            sl,
                            el,
                          )
                        }
                        onUpdate={(id, comment) =>
                          updateFileNote(selectedFile.path, id, comment)
                        }
                        onRemove={(id) => removeFileNote(selectedFile.path, id)}
                        active={active && sub === "files"}
                      />
                    )}
                  </div>
                </>
              )}
            </div>

            <div
              className={cn(
                "absolute inset-0 overflow-auto",
                sub !== "commits" && "hidden",
              )}
            >
              <CommitList detail={detail} />
            </div>
          </div>
        </>
      )}
    </div>
  );
});

const EMPTY: Annotation[] = [];

function StatePill({ state, isDraft }: { state: PrState; isDraft: boolean }) {
  const label = isDraft
    ? "Draft"
    : state.charAt(0) + state.slice(1).toLowerCase();
  const color = isDraft
    ? "bg-[var(--bg-surface-hover)] text-[var(--text-tertiary)]"
    : state === "OPEN"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : state === "MERGED"
        ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
        : "bg-red-500/15 text-red-600 dark:text-red-400";
  return (
    <span
      className={cn(
        "mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wide",
        color,
      )}
    >
      {label}
    </span>
  );
}

function SubTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "border-b-2 py-2 text-[12px] transition-colors",
        active
          ? "border-[var(--text)] text-[var(--text)]"
          : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
      )}
    >
      {label}
    </button>
  );
}

function FileRail({
  files,
  selected,
  onSelect,
}: {
  files: FileDiff[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="w-[240px] shrink-0 overflow-auto border-r border-[var(--border)] py-1">
      {files.map((f) => (
        <button
          key={f.path}
          onClick={() => onSelect(f.path)}
          title={f.path}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] transition-colors",
            f.path === selected
              ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]",
          )}
        >
          <span className="truncate flex-1">{f.path.split("/").pop()}</span>
          <span className="shrink-0 text-[var(--diff-add-bar)]">
            +{f.additions}
          </span>
          <span className="shrink-0 text-[var(--diff-remove-bar)]">
            −{f.deletions}
          </span>
        </button>
      ))}
    </div>
  );
}

function CommitList({ detail }: { detail: PrDetail }) {
  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-1 px-4 py-4">
      {detail.commits.length === 0 ? (
        <div className="py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          No commits.
        </div>
      ) : (
        detail.commits.map((c) => (
          <div
            key={c.oid}
            className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2"
          >
            <code className="shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
              {c.oid.slice(0, 7)}
            </code>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">
              {c.messageHeadline}
            </span>
            <span className="shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
              {c.author}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
