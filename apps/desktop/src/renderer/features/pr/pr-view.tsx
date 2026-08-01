import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { parseUnifiedDiff, type FileDiff } from "@plan/shared/lib/diff-parser";
import { cn } from "@plan/shared/lib/utils";
import {
  usePrMeta,
  usePrConversation,
  usePrDiff,
  usePrHeadSha,
  cachedPrSummary,
  refetchPr,
} from "./pr-store";
import { useProjectAnnotations } from "@/renderer/features/comments/annotation-store";
import { setReloadOverride } from "@/renderer/lib/reload-override";
import { PrConversation } from "./pr-conversation";
import { PrFileDiff } from "./pr-file-diff";
import type { PrCommit, PrState } from "@/common/shared-types";

interface Props {
  encoded: string;
  subPath: string;
  number: number;
  /** False while this PR tab is hidden — gates ⌘R, ⌘F and text selection. */
  active: boolean;
  /** A comment on one of this PR's files to jump to (the comment chip's list):
   *  switches to Files, selects that file, and opens the comment's editor. */
  revealAnnotation?: { id: string; nonce: number; file?: string } | null;
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
  revealAnnotation,
}: Props) {
  // Four independently-loading sections. The header paints from the cached list
  // summary immediately; meta / conversation / diff / headSha each stream in and
  // render (or show a skeleton) on their own, so the slow paginated conversation
  // and the large diff never block the header.
  const summary = cachedPrSummary(encoded, subPath, number);
  const meta = usePrMeta(encoded, subPath, number);
  const conversation = usePrConversation(encoded, subPath, number);
  const diff = usePrDiff(encoded, subPath, number);
  const headSha = usePrHeadSha(encoded, subPath, number);

  const {
    annotationsByPr,
    addPrAnnotation,
    updatePrAnnotation,
    removePrAnnotation,
  } = useProjectAnnotations(encoded);
  const [sub, setSub] = useState<SubTab>("conversation");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const refetch = useCallback(
    () => refetchPr(encoded, subPath, number),
    [encoded, subPath, number],
  );
  const revalidating =
    meta.revalidating ||
    conversation.revalidating ||
    diff.revalidating ||
    headSha.revalidating;

  // ⌘R → force refresh THIS PR (not the whole app), only while visible. Main
  // forwards ⌘R to the renderer (before-input-event) and we claim it here; the
  // claim is released when this tab is hidden, so ⌘R reloads normally elsewhere.
  useEffect(() => {
    if (!active) return;
    return setReloadOverride(() => refetch());
  }, [active, refetch]);

  const files = useMemo(
    () => (diff.value ? parseUnifiedDiff(diff.value) : []),
    [diff.value],
  );

  // Default the Files sub-tab to the first file once the diff lands.
  useEffect(() => {
    if (selectedPath && files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(files[0]?.path ?? null);
  }, [files, selectedPath]);

  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;

  // The comment chip's jump: route to the file the comment lives on. The diff
  // itself does the scrolling once it's the selected file (see PrFileDiff).
  const revealAnnNonce = revealAnnotation?.nonce;
  useEffect(() => {
    if (!revealAnnotation?.file) return;
    setSub("files");
    setSelectedPath(revealAnnotation.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealAnnNonce]);

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
        context: { kind: "pr", pr: number, filePath: label },
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
      startLine: number | undefined,
      endLine: number | undefined,
    ) => {
      addPrAnnotation(fileKey(subPath, number, path), {
        selectedText,
        startOffset,
        endOffset,
        comment,
        side,
        context: {
          kind: "pr",
          pr: number,
          filePath: path,
          side,
          startLine,
          endLine,
        },
        target: { kind: "pr", subPath, number, file: path },
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

  // Header fields prefer loaded meta, falling back to the cached list summary so
  // the header is real (never guessed) from the first paint. `haveHeader` is
  // false only on a truly cold open (no list cached) — then we skeleton it.
  const m = meta.value;
  const headerTitle = m?.title ?? summary?.title ?? null;
  const headerState: PrState = m?.state ?? summary?.state ?? "OPEN";
  const headerDraft = m?.isDraft ?? summary?.isDraft ?? false;
  const baseRef = m?.baseRefName ?? summary?.baseRefName ?? "";
  const headRef = m?.headRefName ?? summary?.headRefName ?? "";
  const haveHeader = !!(m || summary);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-start gap-2">
          {haveHeader ? (
            <StatePill state={headerState} isDraft={headerDraft} />
          ) : (
            <span className="mt-0.5 h-[18px] w-14 shrink-0 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
          )}
          <h2 className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-[var(--text)]">
            {headerTitle ? (
              <>
                {headerTitle}{" "}
                <span className="font-[family-name:var(--font-mono)] text-[var(--text-tertiary)]">
                  #{number}
                </span>
              </>
            ) : (
              <span className="inline-block h-[14px] w-1/2 animate-pulse rounded bg-[var(--bg-surface-hover)] align-middle" />
            )}
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
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {(baseRef || headRef) && (
            <span className="truncate">
              {baseRef} <span className="opacity-60">←</span> {headRef}
            </span>
          )}
          {/* +/- come only from meta; skeleton them until it lands. */}
          {m ? (
            <>
              <span className="text-[var(--diff-add-bar)]">+{m.additions}</span>
              <span className="text-[var(--diff-remove-bar)]">
                −{m.deletions}
              </span>
            </>
          ) : meta.loading ? (
            <span className="h-2 w-16 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
          ) : null}
        </div>
      </div>

      {/* Sub-tabs — counts appear once their section lands. */}
      <div className="flex shrink-0 items-center gap-4 border-b border-[var(--border)] px-4">
        <SubTabButton
          label="Conversation"
          active={sub === "conversation"}
          onClick={() => setSub("conversation")}
        />
        <SubTabButton
          label={`Files${diff.value != null ? ` ${files.length}` : ""}`}
          active={sub === "files"}
          onClick={() => setSub("files")}
        />
        <SubTabButton
          label={`Commits${m ? ` ${m.commits.length}` : ""}`}
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
            prNumber={number}
            description={
              m
                ? {
                    author: m.author,
                    authorIsBot: m.authorIsBot,
                    createdAt: m.createdAt,
                    body: m.body,
                  }
                : null
            }
            descriptionLoading={meta.loading}
            descriptionError={meta.error}
            timeline={conversation.value}
            timelineLoading={conversation.loading}
            timelineError={conversation.error}
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
          {diff.loading ? (
            <FilesSkeleton />
          ) : diff.error ? (
            <PaneMessage>{diff.error}</PaneMessage>
          ) : files.length === 0 ? (
            <PaneMessage>No file changes.</PaneMessage>
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
                    prNumber={number}
                    headSha={headSha.value}
                    headShaPending={headSha.loading}
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
                    revealAnnotation={
                      revealAnnotation?.file === selectedFile.path
                        ? revealAnnotation
                        : null
                    }
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
          {m ? (
            <CommitList commits={m.commits} />
          ) : meta.loading ? (
            <CommitsSkeleton />
          ) : meta.error ? (
            <PaneMessage>{meta.error}</PaneMessage>
          ) : null}
        </div>
      </div>
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

/** A full-pane centered message (empty state or section error). */
function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

/** Files-tab placeholder: a stand-in rail + a few pulsing diff rows. */
function FilesSkeleton() {
  return (
    <>
      <div className="w-[240px] shrink-0 border-r border-[var(--border)] py-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-3 py-1.5">
            <div
              className="h-3 animate-pulse rounded bg-[var(--bg-surface-hover)]"
              style={{ width: `${80 - i * 8}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-[var(--bg-surface-hover)]"
            style={{ width: `${40 + ((i * 37) % 55)}%` }}
          />
        ))}
      </div>
    </>
  );
}

/** Commits-tab placeholder: a few pulsing commit rows. */
function CommitsSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-1 px-4 py-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2"
        >
          <div className="h-2.5 w-12 shrink-0 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
          <div
            className="h-2.5 animate-pulse rounded bg-[var(--bg-surface-hover)]"
            style={{ width: `${50 - i * 6}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function CommitList({ commits }: { commits: PrCommit[] }) {
  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-1 px-4 py-4">
      {commits.length === 0 ? (
        <div className="py-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          No commits.
        </div>
      ) : (
        commits.map((c) => (
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
