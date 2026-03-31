"use client";

import { useState } from "react";
import { useStore } from "@plan/shared/lib/store";
import { useDiffSettings } from "@plan/shared/lib/settings";
import { useTheme } from "@plan/shared/components/theme-provider";
import { PlanInput } from "@plan/shared/components/plan-input";
import { InteractiveDiff } from "@plan/shared/components/interactive-diff";
import { MessageOutput } from "@plan/shared/components/message-output";

const HISTORY_PREVIEW_LEN = 60;

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export default function Home() {
  const {
    versions,
    addVersion,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    reset,
  } = useStore();
  const { theme, toggle } = useTheme();
  const [settings, updateSettings] = useDiffSettings();
  const [compareBase, setCompareBase] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);

  const latestIdx = versions.length - 1;
  const latest = versions.length > 0 ? versions[latestIdx] : null;
  const isFirstVersion = versions.length === 1;

  // The left side of the diff: user picks which version to compare against
  const leftVersion = versions[compareBase] ?? null;
  const leftText = leftVersion?.text ?? "";

  // For v1, diff against empty string so everything shows as additions
  const diffOldText = isFirstVersion ? "" : leftText;

  function handleAddVersion(text: string) {
    setCompareBase(versions.length - 1);
    addVersion(text);
  }

  return (
    <div className="mx-auto min-h-screen max-w-[1800px] px-6 py-8">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <h1
          className="font-[family-name:var(--font-mono)] text-base font-semibold tracking-tight"
          style={{ color: "var(--text)" }}
        >
          plan
        </h1>
        <div className="flex items-center gap-2">
          {versions.length > 0 && (
            <button
              onClick={() => {
                reset();
                setCompareBase(0);
                setHistoryOpen(false);
              }}
              className="rounded-md px-3 py-1.5 text-xs transition-colors hover:opacity-70"
              style={{ color: "var(--text-tertiary)" }}
            >
              Start over
            </button>
          )}
          <button
            onClick={toggle}
            className="flex items-center justify-center rounded-md border p-2 transition-colors hover:bg-[var(--bg-surface-hover)]"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      {/* Empty state */}
      {!latest && (
        <div className="mt-24 flex flex-col items-center">
          <p
            className="mb-1 font-[family-name:var(--font-mono)] text-sm"
            style={{ color: "var(--text-secondary)" }}
          >
            Paste a plan to start iterating.
          </p>
          <p
            className="mb-6 text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            Select text, comment, copy the message, send it back, paste the new
            version, repeat.
          </p>
          <div className="w-full max-w-2xl">
            <PlanInput onSubmit={addVersion} isFirstVersion />
          </div>
        </div>
      )}

      {/* Active session */}
      {latest && (
        <div className="space-y-5">
          {/* Version selector — only shown when >1 version */}
          {versions.length > 1 && (
            <div className="flex items-center gap-3 font-[family-name:var(--font-mono)] text-xs">
              <div className="flex items-center gap-2">
                <select
                  value={compareBase}
                  onChange={(e) => setCompareBase(parseInt(e.target.value))}
                  className="cursor-pointer appearance-none rounded-md border bg-transparent px-2.5 py-1.5 pr-6 font-[family-name:var(--font-mono)] text-xs focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--text)",
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 6px center",
                  }}
                >
                  {versions.slice(0, -1).map((_v, i) => (
                    <option key={i} value={i}>
                      v{i + 1}
                    </option>
                  ))}
                </select>

                <span style={{ color: "var(--text-tertiary)" }}>→</span>

                <span
                  className="rounded-md border px-2.5 py-1.5"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--text-secondary)",
                  }}
                >
                  v{latestIdx + 1}
                </span>
              </div>
            </div>
          )}

          {/* Interactive diff */}
          <InteractiveDiff
            oldText={diffOldText}
            newText={latest.text}
            settings={settings}
            onSettingsChange={updateSettings}
            isFirstVersion={isFirstVersion}
            annotations={latest.annotations}
            onAddAnnotation={(sel, s, e, c, side) =>
              addAnnotation(latestIdx, sel, s, e, c, side)
            }
            onUpdateAnnotation={(id, c) =>
              updateAnnotation(latestIdx, id, c)
            }
            onRemoveAnnotation={(id) => removeAnnotation(latestIdx, id)}
          />

          {/* Generated message */}
          {latest.annotations.length > 0 && (
            <MessageOutput version={latest} />
          )}

          {/* Paste next version */}
          <PlanInput onSubmit={handleAddVersion} isFirstVersion={false} />

          {/* Previous versions */}
          {versions.length > 1 && (
            <section
              className="rounded-lg border"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg-surface)",
              }}
            >
              <button
                onClick={() => {
                  setHistoryOpen((o) => !o);
                  if (historyOpen) setExpandedHistory(null);
                }}
                className="flex w-full items-center gap-2 px-4 py-3 text-left font-[family-name:var(--font-mono)] text-xs transition-colors"
                style={{ color: "var(--text-tertiary)" }}
              >
                <span
                  className="inline-block text-[10px] transition-transform"
                  style={{
                    transform: historyOpen
                      ? "rotate(90deg)"
                      : "rotate(0deg)",
                  }}
                >
                  ▶
                </span>
                Previous versions ({versions.length - 1})
              </button>

              {historyOpen && (
                <div style={{ borderTop: "1px solid var(--border)" }}>
                  {versions
                    .slice(0, -1)
                    .reverse()
                    .map((v, ri) => {
                      const i = versions.length - 2 - ri;
                      const isExpanded = expandedHistory === i;
                      const isLast = ri === versions.length - 2;

                      return (
                        <div
                          key={v.id}
                          style={{
                            borderBottom: isLast
                              ? undefined
                              : "1px solid var(--border)",
                          }}
                        >
                          <button
                            onClick={() =>
                              setExpandedHistory(isExpanded ? null : i)
                            }
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-left font-[family-name:var(--font-mono)] text-xs transition-colors"
                            style={{ color: "var(--text-tertiary)" }}
                          >
                            <span
                              className="inline-block text-[10px] transition-transform"
                              style={{
                                transform: isExpanded
                                  ? "rotate(90deg)"
                                  : "rotate(0deg)",
                              }}
                            >
                              ▶
                            </span>
                            <span style={{ color: "var(--text-secondary)" }}>
                              v{i + 1}
                            </span>
                            <span
                              className="truncate"
                              style={{ maxWidth: "60%" }}
                            >
                              {v.text.split("\n")[0].slice(0, HISTORY_PREVIEW_LEN)}
                            </span>
                          </button>

                          {isExpanded && (
                            <div className="px-4 pb-3">
                              <pre
                                className="max-h-[400px] overflow-auto whitespace-pre rounded-md border p-3 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed"
                                style={{
                                  background: "var(--bg)",
                                  borderColor: "var(--border)",
                                  color: "var(--text)",
                                }}
                              >
                                {v.text}
                              </pre>
                              {v.annotations.length > 0 && (
                                <div
                                  className="mt-2 text-xs"
                                  style={{ color: "var(--text-tertiary)" }}
                                >
                                  {v.annotations.length} comment
                                  {v.annotations.length !== 1 ? "s" : ""} on
                                  this version
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
