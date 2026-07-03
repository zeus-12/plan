/**
 * Inline rendering for Claude's ExitPlanMode tool calls in the chat.
 *
 * Claude Code emits an `ExitPlanMode` tool_use every time the agent presents or
 * revises a plan; `input.plan` is the full markdown. Each revision is its own
 * transcript entry, so the ordered list of ExitPlanMode parts in a session is
 * the plan's full version history.
 *
 * This card renders one version — the one at its point in the chat — as a clean,
 * first-class "Plan" block. The body is injected (not built here) so it goes
 * through the chat's annotation-aware markdown path: selecting text comments on
 * the plan exactly like normal assistant text, with no separate comment bucket.
 *
 * When a prior version exists, "Compare changes" swaps the body for the shared
 * InteractiveDiff against an earlier version (read-only — comments live on the
 * plan body, not the diff).
 */

import { useCallback, useState } from "react";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { useProjectAnnotations } from "../lib/annotation-store";

export interface PlanVersionInfo {
  text: string;
  timestamp: string;
}

/** Defensive parse — the plan markdown, or null if the input isn't a plan. */
export function parsePlanInput(input: unknown): string | null {
  if (input == null || typeof input !== "object") return null;
  const plan = (input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.length > 0 ? plan : null;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface Props {
  /** All ExitPlanMode versions in the session, in order. */
  versions: PlanVersionInfo[];
  /** Which version this card renders (index into `versions`). */
  versionIndex: number;
  /** Annotation-aware markdown body for `versions[versionIndex]` (commentable). */
  body: React.ReactNode;
  /** Project key for the shared annotation store. */
  encoded: string;
  /** The plan's file path (~/.claude/plans/…); enables diff comments. Null when
   *  the card falls back to ExitPlanMode content (no file → read-only diff). */
  planPath: string | null;
}

export function PlanCard({
  versions,
  versionIndex,
  body,
  encoded,
  planPath,
}: Props) {
  const [settings, updateSettings] = useDiffSettings();
  // Diff comments live in the shared annotation store, keyed per version-pair so
  // the highlight always matches the exact diff on screen (versions are
  // immutable, so offsets stay valid). They join the same compose buffer as
  // every other comment via aggregatedDiffAnnotations.
  const { annotationsByFile, setAnnotationsByFile } =
    useProjectAnnotations(encoded);
  // Revisions open on the diff so "what changed in this version" is the first
  // thing you see; the very first version (no prior) has nothing to diff, so it
  // opens on the plan body.
  const [comparing, setComparing] = useState(versionIndex > 0);
  // Default base = the version immediately before this one, so the diff shows
  // what changed in this revision.
  const [baseIdx, setBaseIdx] = useState(Math.max(0, versionIndex - 1));

  const total = versions.length;
  const hasPrior = versionIndex > 0;
  const current = versions[versionIndex];
  const timestamp = formatTime(current?.timestamp ?? "");

  // One bucket per (file, base→current) pair so switching the compare base never
  // mismatches existing highlights. Null (no file) → diff stays read-only.
  const diffKey = planPath ? `${planPath}#${baseIdx}-${versionIndex}` : null;
  const diffAnnotations = diffKey ? (annotationsByFile[diffKey] ?? []) : [];

  const addDiffAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right",
    ) => {
      if (!diffKey) return;
      setAnnotationsByFile((prev) => ({
        ...prev,
        [diffKey]: [
          ...(prev[diffKey] ?? []),
          {
            id: crypto.randomUUID(),
            selectedText,
            startOffset,
            endOffset,
            comment,
            side,
            context: { filePath: planPath ?? undefined },
          },
        ],
      }));
    },
    [diffKey, planPath, setAnnotationsByFile],
  );

  const updateDiffAnnotation = useCallback(
    (id: string, comment: string) => {
      if (!diffKey) return;
      setAnnotationsByFile((prev) => ({
        ...prev,
        [diffKey]: (prev[diffKey] ?? []).map((a) =>
          a.id === id ? { ...a, comment } : a,
        ),
      }));
    },
    [diffKey, setAnnotationsByFile],
  );

  const removeDiffAnnotation = useCallback(
    (id: string) => {
      if (!diffKey) return;
      setAnnotationsByFile((prev) => ({
        ...prev,
        [diffKey]: (prev[diffKey] ?? []).filter((a) => a.id !== id),
      }));
    },
    [diffKey, setAnnotationsByFile],
  );

  return (
    <div className="rounded-md border border-[var(--accent)]/40 bg-[var(--bg)]">
      {/* Card chrome is excluded from chat comment text (data-anno-skip): a
          selection over the plan anchors to the body only, never the header. */}
      <div
        className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]"
        data-anno-skip=""
      >
        <span>📋</span>
        <span>Plan</span>
        <span className="text-[var(--text-tertiary)]">
          v{versionIndex + 1} of {total}
        </span>
        {timestamp && (
          <span className="text-[var(--text-tertiary)]">· {timestamp}</span>
        )}
        {hasPrior && (
          <button
            onClick={() => setComparing((v) => !v)}
            className="ml-auto rounded px-1.5 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
          >
            {comparing ? "View plan" : "Compare changes"}
          </button>
        )}
      </div>

      {comparing && hasPrior ? (
        // The in-card diff owns its own comments (diff annotations); keep the
        // chat's selection handler out of it.
        <div className="px-3 py-2.5" data-anno-skip="">
          {versionIndex > 1 && (
            <div className="mb-2 flex flex-wrap items-center gap-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
              <span>compare with</span>
              {versions.slice(0, versionIndex).map((v, i) => (
                <button
                  key={i}
                  onClick={() => setBaseIdx(i)}
                  className={`rounded px-1.5 py-0.5 transition-colors ${
                    baseIdx === i
                      ? "bg-[var(--accent)] text-[var(--bg)]"
                      : "hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]"
                  }`}
                  title={formatTime(v.timestamp)}
                >
                  v{i + 1}
                </button>
              ))}
            </div>
          )}
          <InteractiveDiff
            oldText={versions[baseIdx]?.text ?? ""}
            newText={current?.text ?? ""}
            settings={settings}
            onSettingsChange={updateSettings}
            language="markdown"
            annotations={diffKey ? diffAnnotations : undefined}
            onAddAnnotation={diffKey ? addDiffAnnotation : undefined}
            onUpdateAnnotation={diffKey ? updateDiffAnnotation : undefined}
            onRemoveAnnotation={diffKey ? removeDiffAnnotation : undefined}
            // Several revision cards can show their diffs at once — don't let
            // every one grab ⌘F.
            findEnabled={false}
          />
        </div>
      ) : (
        <div className="px-3 py-2.5">{body}</div>
      )}
    </div>
  );
}
