import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import {
  detectLanguage,
  languageFromPath,
} from "@plan/shared/lib/highlight";
import type { Plan } from "../../shared-types";

interface Props {
  plan: Plan;
  /** Comments live in the project-wide store so they join the unified
   *  "Add to chat" buffer alongside code-diff and chat comments. */
  annotations: Annotation[];
  onAddAnnotation: (
    selectedText: string,
    startOffset: number,
    endOffset: number,
    comment: string,
    side: "left" | "right"
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  /** Clear this plan's comments when the compared text changes (offsets shift). */
  onResetAnnotations: () => void;
  /** True while the Plans pane is the visible one — gates the ⌘F find widget. */
  active?: boolean;
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function PlanViewer({
  plan,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onResetAnnotations,
  active = true,
}: Props) {
  const [settings, updateSettings] = useDiffSettings();

  const latestIdx = plan.versions.length - 1;
  const latest = plan.versions[latestIdx];
  const latestId = latest?.id;
  const isFirstVersion = plan.versions.length <= 1;

  // Default to the version immediately BEFORE the latest, so the diff always
  // shows the most recent change. The user can still pick an older base.
  const [compareIdx, setCompareIdx] = useState<number>(() =>
    Math.max(0, latestIdx - 1)
  );

  // When a new version streams in, the latest changes — snap the base back to
  // "previous" so the diff keeps tracking the newest change instead of being
  // frozen against whatever version was latest when this view first mounted.
  const seenLatestRef = useRef(latestId);
  useEffect(() => {
    if (seenLatestRef.current === latestId) return;
    seenLatestRef.current = latestId;
    setCompareIdx(Math.max(0, plan.versions.length - 2));
  }, [latestId, plan.versions.length]);

  const leftText = isFirstVersion ? "" : plan.versions[compareIdx]?.text ?? "";
  const rightText = latest?.text ?? "";

  const language = useMemo(() => {
    const fromPath = languageFromPath(plan.filePath);
    if (fromPath) return fromPath;
    const detected = detectLanguage(rightText);
    return detected === "plaintext" ? "markdown" : detected;
  }, [plan.filePath, rightText]);

  // Reset annotations whenever the compared text changes (offsets shift). Skip
  // the first run so restored comments survive a remount (e.g. switching plans).
  const textSig = `${leftText.length}:${rightText.length}`;
  const prevSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSigRef.current === null) {
      prevSigRef.current = textSig;
      return;
    }
    if (prevSigRef.current !== textSig) {
      prevSigRef.current = textSig;
      onResetAnnotations();
    }
  }, [textSig, onResetAnnotations]);

  if (!latest) {
    return (
      <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No content
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11px]">
          <span className="text-[var(--text-tertiary)]">plan</span>
          <span className="truncate text-[var(--text-secondary)]">
            {basename(plan.filePath)}
          </span>
          <span className="ml-2 text-[var(--text-tertiary)]">
            v{latestIdx + 1} of {plan.versions.length}
          </span>
        </div>
        {!isFirstVersion && (
          <select
            value={compareIdx}
            onChange={(e) => setCompareIdx(parseInt(e.target.value))}
            className="cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-transparent px-2 py-0.5 pr-5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)]"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 4px center",
            }}
          >
            {plan.versions.slice(0, -1).map((_v, i) => (
              <option key={i} value={i}>
                Compare with v{i + 1}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <InteractiveDiff
          oldText={leftText}
          newText={rightText}
          settings={settings}
          onSettingsChange={updateSettings}
          findEnabled={active}
          isFirstVersion={isFirstVersion}
          language={language}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
        />
      </div>
    </div>
  );
}
