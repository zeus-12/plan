import { useEffect, useRef, useState } from "react";
import { useTheme } from "@plan/shared/components/theme-provider";
import { groupThemes, swatchFor } from "@plan/shared/lib/themes";
import { Button } from "@plan/shared/components/ui/button";
import { cn } from "@plan/shared/lib/utils";

function SunIcon() {
  return (
    <svg
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

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Theme picker: the header's sun/moon button, now opening a theme list. */
export function ThemeMenu() {
  const { theme, isDark, setTheme, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="Choose theme"
        title="Theme"
      >
        {isDark ? <MoonIcon /> : <SunIcon />}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-lg">
          {groupThemes(themes).map((group, i) => (
            <div
              key={group.id}
              className={cn(
                i > 0 && "mt-1 border-t border-[var(--border)] pt-1",
              )}
            >
              <div className="px-2 py-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                {group.label}
              </div>
              {group.themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTheme(t.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-surface-hover)]",
                    t.id === theme
                      ? "text-[var(--text)]"
                      : "text-[var(--text-secondary)]",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                      style={{ background: swatchFor(t) }}
                    />
                    {t.label}
                  </span>
                  {t.id === theme && <CheckIcon />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
