import { useCallback, useEffect, useRef, useState } from "react";
import type { ExternalApp } from "../../shared-types";
import {
  useDefaultExternalApp,
  useExternalApps,
} from "../lib/external-apps-store";
import { cn } from "@plan/shared/lib/utils";

/**
 * "Open in…" — a split control: the left half opens the target in the current
 * default app, the chevron picks a different one (and that pick becomes the new
 * default). Renders nothing until main has confirmed at least one installed app,
 * so the menu never offers something that isn't there.
 */

interface Props {
  encoded: string;
  /** Workspace-relative path, or null to target the workspace itself. */
  relPath?: string | null;
  /** Repo sub-path, for multi-repo projects. */
  subPath?: string;
  /** Hide the "Open" label, leaving just the app icon (tight toolbars). */
  compact?: boolean;
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** The app's real bundle icon, or a neutral placeholder when we couldn't read
 *  one — never a stand-in glyph pretending to be that app's brand. */
function AppIcon({ app, size }: { app: ExternalApp; size: number }) {
  if (!app.icon) {
    return (
      <span
        style={{ width: size, height: size }}
        className="shrink-0 rounded-[3px] border border-[var(--border-strong)]"
      />
    );
  }
  return (
    <img
      src={app.icon}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[3px]"
    />
  );
}

export function OpenInMenu({
  encoded,
  relPath = null,
  subPath = "",
  compact = false,
}: Props) {
  const apps = useExternalApps();
  const [defaultApp, setDefaultApp] = useDefaultExternalApp();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const openIn = useCallback(
    async (appId: string) => {
      setOpen(false);
      setDefaultApp(appId);
      const r = await window.electronAPI.openInExternalApp(
        appId,
        encoded,
        relPath,
        subPath,
      );
      setError(r.ok ? null : (r.error ?? "Could not open that app."));
    },
    [encoded, relPath, subPath, setDefaultApp],
  );

  const copyPath = useCallback(async () => {
    setOpen(false);
    const path = await window.electronAPI.resolveTargetPath(
      encoded,
      relPath,
      subPath,
    );
    await navigator.clipboard.writeText(path);
  }, [encoded, relPath, subPath]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // 1-9 pick an app straight from the open menu, matching the row hints.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < apps.length) {
        e.preventDefault();
        void openIn(apps[index].id);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, apps, openIn]);

  if (!defaultApp) return null;

  const targetLabel = relPath ? "file" : "project";

  return (
    <div ref={rootRef} className="relative flex items-center">
      <div className="flex items-center rounded-md border border-[var(--border)]">
        <button
          onClick={() => void openIn(defaultApp.id)}
          title={`Open this ${targetLabel} in ${defaultApp.label}`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-l-md text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
            compact ? "px-1.5" : "pl-2 pr-2",
          )}
        >
          <AppIcon app={defaultApp} size={14} />
          {!compact && <span>Open</span>}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Choose an app"
          aria-expanded={open}
          title="Choose an app"
          className="flex h-7 w-6 items-center justify-center rounded-r-md border-l border-[var(--border)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] [&_svg]:size-3"
        >
          <ChevronDown />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-max min-w-[190px] rounded-md border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-lg">
          {apps.map((app, i) => (
            <button
              key={app.id}
              onClick={() => void openIn(app.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-surface-hover)]",
                app.id === defaultApp.id
                  ? "text-[var(--text)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              <AppIcon app={app} size={16} />
              <span className="flex-1">{app.label}</span>
              {i < 9 && (
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {i + 1}
                </span>
              )}
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--border)]" />
          <button
            onClick={() => void copyPath()}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
          >
            <span className="flex w-4 justify-center text-[var(--text-tertiary)]">
              <CopyIcon />
            </span>
            <span className="flex-1">Copy path</span>
          </button>
        </div>
      )}

      {error && (
        <span
          role="status"
          className="ml-2 text-[11px] text-[var(--text-tertiary)]"
        >
          {error}
        </span>
      )}
    </div>
  );
}
