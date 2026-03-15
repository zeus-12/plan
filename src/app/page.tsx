"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { useTheme } from "@/components/theme-provider";
import { PlanInput } from "@/components/plan-input";
import { InteractiveDiff } from "@/components/interactive-diff";
import { MessageOutput } from "@/components/message-output";

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
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareBase, setCompareBase] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);

  const latestIdx = versions.length - 1;
  const latest = versions.length > 0 ? versions[latestIdx] : null;
  const prev = latestIdx > 0 ? versions[latestIdx - 1] : null;

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-6 py-8">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <h1
          className="font-[family-name:var(--font-mono)] text-base font-semibold tracking-tight"
          style={{ color: "var(--text)" }}
        >
          planwise
        </h1>
        <div className="flex items-center gap-2">
          {versions.length > 0 && (
            <button
              onClick={reset}
              className="rounded-md px-3 py-1.5 text-xs transition-colors hover:opacity-70"
              style={{ color: "var(--text-tertiary)" }}
            >
              Start over
            </button>
          )}
          <button
            onClick={toggle}
            className="rounded-md border px-3 py-1.5 text-xs transition-colors"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      {/* Empty state */}
      {!latest && (
        <div className="mt-24 flex flex-col items-center">
          <p
            className="mb-1 font-[family-name:var(--font-mono)] text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            Paste a plan to start iterating.
          </p>
          <p
            className="mb-6 text-xs"
            style={{ color: "var(--text-tertiary)" }}
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
        <div className="space-y-6">
          {/* Version label */}
          <div
            className="font-[family-name:var(--font-mono)] text-xs"
            style={{ color: "var(--text-tertiary)" }}
          >
            {prev
              ? `v${latestIdx} → v${latestIdx + 1}`
              : "v1"}
            {" — select text to comment"}
          </div>

          {/* Interactive diff (main view) */}
          <InteractiveDiff
            oldText={prev?.text ?? ""}
            newText={latest.text}
            annotations={latest.annotations}
            onAddAnnotation={(sel, s, e, c) =>
              addAnnotation(latestIdx, sel, s, e, c)
            }
            onUpdateAnnotation={(id, c) =>
              updateAnnotation(latestIdx, id, c)
            }
            onRemoveAnnotation={(id) => removeAnnotation(latestIdx, id)}
          />

          {/* Generated message — right below diff, prominent */}
          {latest.annotations.length > 0 && (
            <MessageOutput version={latest} />
          )}

          {/* Paste next version */}
          <PlanInput onSubmit={addVersion} isFirstVersion={false} />

          {/* Compare with earlier version */}
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
                  setCompareOpen((o) => !o);
                }}
                className="flex w-full items-center gap-2 px-4 py-3 text-left font-[family-name:var(--font-mono)] text-xs transition-colors"
                style={{ color: "var(--text-tertiary)" }}
              >
                <span
                  className="inline-block text-[10px] transition-transform"
                  style={{
                    transform: compareOpen
                      ? "rotate(90deg)"
                      : "rotate(0deg)",
                  }}
                >
                  ▶
                </span>
                Compare versions
              </button>

              {compareOpen && (
                <div
                  className="px-4 pb-4"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <div className="mt-3 mb-3 flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      {versions.slice(0, -1).map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setCompareBase(i)}
                          className="rounded-md border px-3 py-1 font-[family-name:var(--font-mono)] text-xs transition-colors"
                          style={{
                            borderColor:
                              compareBase === i
                                ? "var(--accent)"
                                : "var(--border)",
                            background:
                              compareBase === i
                                ? "var(--accent)"
                                : "transparent",
                            color:
                              compareBase === i
                                ? "var(--bg)"
                                : "var(--text-tertiary)",
                          }}
                        >
                          v{i + 1}
                        </button>
                      ))}
                    </div>
                    <span
                      className="font-[family-name:var(--font-mono)] text-xs"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      → v{latestIdx + 1} (current)
                    </span>
                  </div>

                  <InteractiveDiff
                    oldText={versions[compareBase].text}
                    newText={latest.text}
                  />
                </div>
              )}
            </section>
          )}

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

                      return (
                        <div
                          key={v.id}
                          style={{
                            borderBottom:
                              ri < versions.length - 2
                                ? "1px solid var(--border)"
                                : undefined,
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
                            <span className="truncate" style={{ maxWidth: "60%" }}>
                              {v.text.split("\n")[0].slice(0, 60)}
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
                                  style={{
                                    color: "var(--text-tertiary)",
                                  }}
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
