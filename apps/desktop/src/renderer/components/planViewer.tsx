import { useCallback, useMemo, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { MessageOutput } from "@plan/shared/components/message-output";
import {
  detectLanguage,
  languageFromPath,
} from "@plan/shared/lib/highlight";
import type { Plan } from "../../shared-types";

interface Props {
  plan: Plan;
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function PlanViewer({ plan }: Props) {
  const [settings, updateSettings] = useDiffSettings();
  const [compareIdx, setCompareIdx] = useState<number>(() =>
    plan.versions.length > 1 ? plan.versions.length - 2 : 0
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  const latestIdx = plan.versions.length - 1;
  const latest = plan.versions[latestIdx];
  const isFirstVersion = plan.versions.length <= 1;

  const leftText = isFirstVersion ? "" : plan.versions[compareIdx]?.text ?? "";
  const rightText = latest?.text ?? "";

  const language = useMemo(() => {
    const fromPath = languageFromPath(plan.filePath);
    if (fromPath) return fromPath;
    const detected = detectLanguage(rightText);
    return detected === "plaintext" ? "markdown" : detected;
  }, [plan.filePath, rightText]);

  // Reset annotations whenever the selected text changes (offsets shift)
  const textSig = `${leftText.length}:${rightText.length}`;
  useMemo(() => {
    setAnnotations([]);
    return textSig;
  }, [textSig]);

  const addAnnotation = useCallback(
    (
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
      side: "left" | "right"
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
    []
  );

  const updateAnnotation = useCallback((id: string, comment: string) => {
    setAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, comment } : a))
    );
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

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
          isFirstVersion={isFirstVersion}
          language={language}
          annotations={annotations}
          onAddAnnotation={addAnnotation}
          onUpdateAnnotation={updateAnnotation}
          onRemoveAnnotation={removeAnnotation}
        />
      </div>

      {annotations.length > 0 && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-surface)] p-3">
          <MessageOutput
            annotations={annotations}
            options={{
              intro: "I have some feedback on the plan:",
              leftLabel: "the previous version",
              rightLabel: "the current version",
            }}
          />
        </div>
      )}
    </div>
  );
}
