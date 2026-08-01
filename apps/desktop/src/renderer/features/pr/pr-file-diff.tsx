import { memo, useEffect, useMemo, useState } from "react";
import type { FileDiff } from "@plan/shared/lib/diff-parser";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { detectLanguage, languageFromPath } from "@plan/shared/lib/highlight";
import { reconstructOldText } from "@plan/shared/lib/diff-reconstruct";
import { TextShimmer } from "@plan/shared/components/ui/text-shimmer";
import { useDiffBlame } from "@/renderer/features/git/blame/use-diff-blame";

interface Props {
  encoded: string;
  subPath: string;
  file: FileDiff;
  /** Shown in the comment popover's source pill, kept out of the file path so
   *  the path can truncate without eating the number. */
  prNumber: number;
  /** PR head commit SHA (from the PR detail) — the "new" side of the diff. */
  headSha: string | null;
  /** True while the head SHA is still being resolved — distinguishes "loading"
   * from a null headSha that failed to resolve ("unavailable"). */
  headShaPending: boolean;
  annotations: Annotation[];
  onAdd: (
    selectedText: string,
    startOffset: number,
    endOffset: number,
    comment: string,
    side: "left" | "right",
    startLine: number | undefined,
    endLine: number | undefined,
  ) => void;
  onUpdate: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  /** An existing comment to scroll to and open the editor on (comment chip). */
  revealAnnotation?: { id: string; nonce: number } | null;
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
  prNumber,
  headSha,
  headShaPending,
  annotations,
  onAdd,
  onUpdate,
  onRemove,
  revealAnnotation,
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

  // ⌥Z — toggle line wrap, same as the local diff (file-diff-viewer). PR files
  // render InteractiveDiff directly rather than through that wrapper, so the
  // shortcut has to be wired here too. Match `e.code` (not `e.key`): Option+letter
  // emits a special glyph on macOS ("Ω" for z), so the physical code is the only
  // reliable signal.
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

  // Inline blame for the head (right) side only, at the PR's head commit —
  // which resolveHeadSha fetched into the local object store, so every line
  // attributes to a real commit. The old side is RECONSTRUCTED text with no
  // commit to anchor honest blame to (base is deliberately never resolved —
  // see resolveHeadSha), so it gets no annotation rather than a guess.
  const blameRelPath = useMemo(() => {
    const p = file.newPath ?? file.path;
    return subPath ? `${subPath}/${p}` : p;
  }, [subPath, file.newPath, file.path]);
  const {
    blame,
    card: blameCard,
    hasCard: hasBlameCard,
    closeCard: blameClose,
  } = useDiffBlame(
    encoded,
    blameRelPath,
    null,
    headSha && contents && !contents.binary && contents.newText
      ? { kind: "rev", rev: headSha, text: contents.newText }
      : null,
  );

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
        {/* Reserve the gear's height (h-8) so the header row doesn't grow when
            InteractiveDiff mounts and portals its settings button in here —
            otherwise switching files visibly shifts this bar down. */}
        <div ref={setSettingsSlot} className="flex h-8 items-center" />
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto p-3"
        // The blame card is fixed-position; close it when the rows scroll away.
        onScroll={hasBlameCard ? blameClose : undefined}
      >
        {file.binary ? (
          <Placeholder>Binary file</Placeholder>
        ) : !headSha ? (
          headShaPending ? (
            <Placeholder>
              <TextShimmer duration={2.4}>Loading…</TextShimmer>
            </Placeholder>
          ) : (
            <Placeholder>
              Diff unavailable — couldn&apos;t fetch this PR&apos;s head commit.
            </Placeholder>
          )
        ) : !contents ? (
          <Placeholder>
            <TextShimmer duration={2.4}>Loading…</TextShimmer>
          </Placeholder>
        ) : contents.binary ? (
          <Placeholder>Binary file</Placeholder>
        ) : (
          <InteractiveDiff
            commentSource={{ filePath: file.path, pr: prNumber }}
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
            onAddAnnotation={onAdd}
            onUpdateAnnotation={onUpdate}
            onRemoveAnnotation={onRemove}
            revealAnnotation={revealAnnotation}
            blame={blame}
          />
        )}
      </div>
      {blameCard}
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
