import { memo, useEffect, useMemo, useState } from "react";
import type { FileDiff } from "@plan/shared/lib/diff-parser";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { detectLanguage, languageFromPath } from "@plan/shared/lib/highlight";
import { reconstructOldText } from "@plan/shared/lib/diff-reconstruct";

interface Props {
  encoded: string;
  subPath: string;
  file: FileDiff;
  /** PR head commit SHA (from the PR detail) — the "new" side of the diff. */
  headSha: string | null;
  annotations: Annotation[];
  onAdd: (
    selectedText: string,
    startOffset: number,
    endOffset: number,
    comment: string,
    side: "left" | "right",
    startLine: number,
    endLine: number,
  ) => void;
  onUpdate: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  /** False while this file's pane is hidden — gates the diff's ⌘F handler. */
  active: boolean;
}

/**
 * One PR file rendered with the shared InteractiveDiff — the exact same viewer
 * as the local Changes tab, so folding, syntax highlighting, and select-to-
 * comment all behave identically. Read-only (no per-hunk staging): a PR diff
 * isn't the working tree.
 *
 * The "new" side is the PR head blob (`git show <headSha>:<path>` in main); the
 * "old" side is reconstructed here by reverse-applying this file's authoritative
 * `gh pr diff` hunks to that blob — so it's correct even for merged PRs, where
 * the base branch has moved on and a base-blob fetch would return post-merge
 * (identical) content.
 */
export const PrFileDiff = memo(function PrFileDiff({
  encoded,
  subPath,
  file,
  headSha,
  annotations,
  onAdd,
  onUpdate,
  onRemove,
  active,
}: Props) {
  const [settings, updateSettings] = useDiffSettings();
  const [settingsSlot, setSettingsSlot] = useState<HTMLDivElement | null>(null);
  // The fetched head blob text; null while loading, undefined-safe binary flag.
  const [head, setHead] = useState<{ text: string; binary: boolean } | null>(
    null,
  );

  useEffect(() => {
    setHead(null);
    let cancelled = false;
    window.electronAPI
      .getPrFileView(encoded, subPath, headSha, file.newPath)
      .then((c) => {
        if (!cancelled) setHead(c);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded, subPath, headSha, file.newPath]);

  // Old side: reverse-apply this file's diff to the head blob.
  const contents = useMemo(() => {
    if (!head) return null;
    return {
      oldText: reconstructOldText(head.text, file.body),
      newText: head.text,
      binary: head.binary,
    };
  }, [head, file.body]);

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
  const effectiveLanguage = detected ?? "plaintext";

  const viewOldText = contents?.oldText ?? "";
  const viewNewText = contents?.newText ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11px]">
          <span className="text-[var(--text-tertiary)]">{file.status}</span>
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
        <div ref={setSettingsSlot} className="flex items-center" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {file.binary ? (
          <Placeholder>Binary file</Placeholder>
        ) : !headSha ? (
          <Placeholder>
            Diff unavailable — couldn&apos;t fetch this PR&apos;s head commit.
          </Placeholder>
        ) : !contents ? (
          <Placeholder>Loading…</Placeholder>
        ) : contents.binary ? (
          <Placeholder>Binary file</Placeholder>
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
            onAddAnnotation={(text, start, end, comment, side) => {
              const source = side === "left" ? viewOldText : viewNewText;
              onAdd(
                text,
                start,
                end,
                comment,
                side,
                offsetToLine(source, start),
                offsetToLine(source, Math.max(start, end - 1)),
              );
            }}
            onUpdateAnnotation={onUpdate}
            onRemoveAnnotation={onRemove}
          />
        )}
      </div>
    </div>
  );
});

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
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
