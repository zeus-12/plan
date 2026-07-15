"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type DiffSettings, FONT_SIZE_OPTIONS } from "../../lib/settings";

/* ── Diff settings controls ─────────────────────────────────
 * The same widgets serve two hosts as two layouts: "bar" lays them out inline
 * above the diff (the web surface); "popover" collapses them behind a gear
 * button (the desktop surface, where the header is already crowded) —
 * optionally portaled into a caller-provided header slot so the trigger lives
 * where the user expects it while the logic stays here.
 *
 * The one piece of diff state these controls need is whether the user has
 * manually expanded "N unchanged lines" sections: that puts the view in a
 * mixed state neither "Changes only" nor "All lines" reflects, and clicking
 * "Changes only" then means "collapse my expansions" rather than a settings
 * change. The host passes that as `separatorsCustomized` +
 * `onCollapseSeparators`. */

export interface DiffSettingsControlsProps {
  settings: DiffSettings;
  onSettingsChange?: (patch: Partial<DiffSettings>) => void;
  /** First version of a plan: no old side, so the view-mode toggle is moot. */
  isFirstVersion: boolean;
  variant: "bar" | "popover";
  /** Portal target for the popover gear; ignored for the bar variant. */
  portalTarget?: HTMLElement | null;
  /** True while the user has manually expanded hidden-lines separators. */
  separatorsCustomized: boolean;
  /** Collapse those manual expansions back (without re-firing hideUnchanged). */
  onCollapseSeparators: () => void;
}

export function DiffSettingsControls({
  settings,
  onSettingsChange,
  isFirstVersion,
  variant,
  portalTarget,
  separatorsCustomized,
  onCollapseSeparators,
}: DiffSettingsControlsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss the popover on any click outside it (incl. the trigger).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!onSettingsChange) return null;

  function renderViewModeToggle() {
    if (isFirstVersion || !onSettingsChange) return null;
    return (
      <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
        {(["split", "unified"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => onSettingsChange({ viewMode: mode })}
            className={`px-2.5 py-1 transition-colors ${mode === "split" ? "rounded-l-md" : "rounded-r-md border-l border-[var(--border)]"} ${
              settings.viewMode === mode
                ? "bg-[var(--accent)] text-[var(--bg)]"
                : "text-[var(--text-tertiary)]"
            }`}
          >
            {mode === "split" ? "Split" : "Unified"}
          </button>
        ))}
      </div>
    );
  }

  function renderFontSizeSelect() {
    if (!onSettingsChange) return null;
    return (
      <select
        value={settings.fontSize}
        onChange={(e) =>
          onSettingsChange({
            fontSize: Number(e.target.value) as DiffSettings["fontSize"],
          })
        }
        className="cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-transparent px-2 py-1 pr-5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 4px center",
        }}
      >
        {FONT_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
    );
  }

  function renderHideUnchangedToggle() {
    if (!onSettingsChange) return null;
    return (
      <div className="inline-flex rounded-md border border-[var(--border)] font-[family-name:var(--font-mono)] text-[11px]">
        {([true, false] as const).map((hide) => {
          // When the user has manually expanded "N unchanged lines" sections
          // we're in a mixed state — neither toggle reflects reality.
          const isActive =
            !separatorsCustomized && settings.hideUnchanged === hide;
          return (
            <button
              key={String(hide)}
              onClick={() => {
                if (hide && settings.hideUnchanged && separatorsCustomized) {
                  // Already in changes-only mode but with expansions —
                  // collapse them back without re-firing hideUnchanged.
                  onCollapseSeparators();
                  return;
                }
                onSettingsChange({ hideUnchanged: hide });
              }}
              className={`px-2.5 py-1 transition-colors ${hide ? "rounded-l-md" : "rounded-r-md border-l border-[var(--border)]"} ${
                isActive
                  ? "bg-[var(--accent)] text-[var(--bg)]"
                  : "text-[var(--text-tertiary)]"
              }`}
            >
              {hide ? "Changes only" : "All lines"}
            </button>
          );
        })}
      </div>
    );
  }

  function renderLineWrapButton() {
    if (!onSettingsChange) return null;
    return (
      <button
        onClick={() => onSettingsChange({ lineWrap: !settings.lineWrap })}
        className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
          settings.lineWrap
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)]"
        }`}
      >
        Line wrap
      </button>
    );
  }

  function renderIgnoreWhitespaceButton() {
    if (!onSettingsChange) return null;
    return (
      <button
        onClick={() =>
          onSettingsChange({ ignoreWhitespace: !settings.ignoreWhitespace })
        }
        className={`rounded-md border px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] transition-colors ${
          settings.ignoreWhitespace
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)]"
        }`}
      >
        Ignore whitespace
      </button>
    );
  }

  if (variant === "bar") {
    return (
      <div className="mb-2 flex items-center justify-end gap-2">
        {renderViewModeToggle()}
        {renderFontSizeSelect()}
        {renderHideUnchangedToggle()}
        {renderLineWrapButton()}
        {renderIgnoreWhitespaceButton()}
      </div>
    );
  }

  if (!portalTarget) return null;
  const rows: { label: string; control: ReactNode }[] = [
    { label: "View", control: renderViewModeToggle() },
    { label: "Font size", control: renderFontSizeSelect() },
    { label: "Lines", control: renderHideUnchangedToggle() },
    { label: "Wrap", control: renderLineWrapButton() },
    { label: "Whitespace", control: renderIgnoreWhitespaceButton() },
  ].filter((r) => r.control);

  const menu = (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Diff settings"
        aria-label="Diff settings"
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-md border text-[15px] transition-colors ${
          open
            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
        }`}
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 flex w-max flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5 shadow-lg">
          {rows.map(({ label, control }) => (
            <div
              key={label}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-[11px] text-[var(--text-tertiary)]">
                {label}
              </span>
              {control}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return createPortal(menu, portalTarget);
}
