import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ExternalApp } from "@/common/shared-types";
import { basename } from "@plan/shared/lib/path";
import { useDefaultExternalApp, useExternalApps } from "./external-apps-store";
import { cn } from "@plan/shared/lib/utils";

/**
 * "Open in…" — a split control: the left half opens the target in the current
 * default app, the chevron picks a different one (and that pick becomes the new
 * default). Renders nothing until main has confirmed at least one installed app,
 * so the menu never offers something that isn't there.
 *
 * Two targets exist. {@link OpenInMenu} addresses a workspace path the way the
 * rest of the app does (encoded + relPath), and {@link OpenPathMenu} takes an
 * absolute path, for files that belong to no workspace — see
 * `openPathInExternalApp` in main.
 */

interface Props {
  encoded: string;
  /** Workspace-relative path, or null to target the workspace itself. */
  relPath?: string | null;
  /** Repo sub-path, for multi-repo projects. */
  subPath?: string;
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

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MENU_MIN_HEIGHT = 120;

/**
 * Where the menu sits against the button. Right-aligned to it (the control is
 * usually at the right end of a row), below unless the taller side is above,
 * and always inside the window.
 */
function placeMenu(
  anchor: DOMRect,
  menuHeight: number,
  menuWidth: number,
  viewport: { width: number; height: number },
): { top: number; left: number; maxHeight: number } {
  const below = viewport.height - anchor.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const above = anchor.top - MENU_GAP - VIEWPORT_MARGIN;
  const flip = menuHeight > below && above > below;
  const room = Math.max(flip ? above : below, MENU_MIN_HEIGHT);
  const settled = Math.min(menuHeight, room);
  return {
    top: flip
      ? Math.max(VIEWPORT_MARGIN, anchor.top - MENU_GAP - settled)
      : Math.min(
          anchor.bottom + MENU_GAP,
          viewport.height - VIEWPORT_MARGIN - settled,
        ),
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        anchor.right - menuWidth,
        viewport.width - menuWidth - VIEWPORT_MARGIN,
      ),
    ),
    maxHeight: room,
  };
}

/**
 * The control itself, target-agnostic: which apps exist, which one is default,
 * the menu, and the keyboard picks. What "open" means is the caller's business.
 */
function AppSplitButton({
  onOpen,
  onCopyPath,
  title,
  /** Row-sized rather than toolbar-sized. 20px is the ceiling: a transcript
   *  row's line box is 11px × 1.5, so anything taller makes the one row that
   *  carries this control stand off from every other tool row. */
  compact = false,
}: {
  onOpen: (appId: string) => Promise<{ ok: boolean; error?: string }>;
  onCopyPath: () => Promise<string>;
  title: (app: ExternalApp) => string;
  compact?: boolean;
}) {
  const apps = useExternalApps();
  const [defaultApp, setDefaultApp] = useDefaultExternalApp();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({
    top: 0,
    left: 0,
    visibility: "hidden",
  });

  const openIn = useCallback(
    async (appId: string) => {
      setOpen(false);
      setDefaultApp(appId);
      const r = await onOpen(appId);
      setError(r.ok ? null : (r.error ?? "Could not open that app."));
    },
    [onOpen, setDefaultApp],
  );

  const copyPath = useCallback(async () => {
    setOpen(false);
    await navigator.clipboard.writeText(await onCopyPath());
  }, [onCopyPath]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // The menu is portalled to `document.body`, so it has to be measured and
  // placed against the button by hand. Scroll is watched in the capture phase
  // because the transcript that holds this row is itself a scroller.
  useLayoutEffect(() => {
    if (!open) {
      setPos({ top: 0, left: 0, visibility: "hidden" });
      return;
    }
    const place = () => {
      const el = menuRef.current;
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!el || !anchor) return;
      setPos({
        ...placeMenu(anchor, el.offsetHeight, el.offsetWidth, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
        visibility: "visible",
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The menu is no longer a DOM descendant of the button, so it needs its
      // own containment check — otherwise picking an app closes the menu before
      // the click lands on the row.
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
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

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <div className="flex shrink-0 items-center rounded-md border border-[var(--border)]">
        <button
          onClick={() => void openIn(defaultApp.id)}
          title={title(defaultApp)}
          className={cn(
            "flex items-center rounded-l-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
            compact
              ? "h-5 gap-1.5 px-2 text-[11px]"
              : "h-7 gap-1.5 px-2 text-[11px]",
          )}
        >
          <AppIcon app={defaultApp} size={compact ? 13 : 14} />
          <span className="whitespace-nowrap">Open</span>
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Choose an app"
          aria-expanded={open}
          title="Choose an app"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-r-md border-l border-[var(--border)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
            compact
              ? "h-5 w-[18px] [&_svg]:size-[10px]"
              : "h-7 w-6 [&_svg]:size-3",
          )}
        >
          <ChevronDown />
        </button>
      </div>

      {/* Portalled: every ancestor between here and the window clips — the
          transcript scroller, and a user message's collapsed-height mask. */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={pos}
            className="fixed z-50 w-max min-w-[190px] overflow-y-auto rounded-md border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-lg"
          >
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
          </div>,
          document.body,
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

export function OpenInMenu({ encoded, relPath = null, subPath = "" }: Props) {
  const targetLabel = relPath ? "file" : "project";
  return (
    <AppSplitButton
      onOpen={(appId) =>
        window.electronAPI.openInExternalApp(appId, encoded, relPath, subPath)
      }
      onCopyPath={() =>
        window.electronAPI.resolveTargetPath(encoded, relPath, subPath)
      }
      title={(app) => `Open this ${targetLabel} in ${app.label}`}
    />
  );
}

/** The same control for a file addressed by absolute path. */
export function OpenPathMenu({
  path,
  compact = false,
}: {
  path: string;
  compact?: boolean;
}) {
  return (
    <AppSplitButton
      onOpen={(appId) => window.electronAPI.openPathInExternalApp(appId, path)}
      onCopyPath={() => Promise.resolve(path)}
      title={(app) => `Open ${basename(path)} in ${app.label}`}
      compact={compact}
    />
  );
}
