"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type DiffSettings,
  FONT_SIZE_OPTIONS,
} from "../../lib/settings/settings";
import type { ExpandedSeparators } from "../../lib/diff/expanded-separators";

/* ── Diff settings controls ─────────────────────────────────
 * Diff view settings, as a gear button opening a small panel ("popover") or as
 * an inline row of widgets ("bar"). Hosts render this themselves — in a file
 * header, above a diff — so it's present as soon as the host is, whether or not
 * a diff has loaded behind it.
 *
 * The one piece of diff state these controls need is whether the user has
 * manually expanded "N unchanged lines" sections: that puts the view in a
 * mixed state neither "Changes only" nor "All lines" reflects, and clicking
 * "Changes only" then means "collapse my expansions" rather than a settings
 * change. That state is the `separators` handle, shared with the diff. */

export interface DiffSettingsControlsProps {
  settings: DiffSettings;
  onSettingsChange?: (patch: Partial<DiffSettings>) => void;
  /** First version of a plan: no old side, so the view-mode toggle is moot. */
  isFirstVersion?: boolean;
  variant?: "bar" | "popover";
  /** Manual separator expansions, shared with the diff this configures. */
  separators: ExpandedSeparators;
  /** No diff behind the gear yet (still loading, binary, an image) — the button
   *  holds its place rather than appearing once contents arrive. Popover only;
   *  the bar renders beside a diff that's already there. */
  disabled?: boolean;
}

const GEAR_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[15px] transition-colors";

export function DiffSettingsControls({
  settings,
  onSettingsChange,
  isFirstVersion = false,
  variant = "popover",
  separators,
  disabled = false,
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

  // A disabled gear can't be closed by the click-outside handler above.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
            !separators.customized && settings.hideUnchanged === hide;
          return (
            <button
              key={String(hide)}
              onClick={() => {
                if (hide && settings.hideUnchanged && separators.customized) {
                  // Already in changes-only mode but with expansions —
                  // collapse them back without re-firing hideUnchanged.
                  separators.collapseAll();
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

  const rows: { label: string; control: ReactNode }[] = [
    { label: "View", control: renderViewModeToggle() },
    { label: "Font size", control: renderFontSizeSelect() },
    { label: "Lines", control: renderHideUnchangedToggle() },
    { label: "Wrap", control: renderLineWrapButton() },
    { label: "Whitespace", control: renderIgnoreWhitespaceButton() },
  ].filter((r) => r.control);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Diff settings"
        aria-label="Diff settings"
        aria-expanded={open}
        className={`${GEAR_CLASS} ${
          disabled
            ? "cursor-default border-[var(--border)] text-[var(--text-tertiary)] opacity-40"
            : open
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
}
