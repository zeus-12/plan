"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

/**
 * A trimmed shadcn-style Sidebar. Each Sidebar gets its own Provider so the
 * app can host multiple independent sidebars side-by-side with their own
 * persisted-open state and keyboard shortcuts.
 */

interface ShortcutSpec {
  /** Single letter or named key, case-insensitive. */
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

interface SidebarContextValue {
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  toggle: () => void;
  shortcut?: ShortcutSpec;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside <SidebarProvider>");
  return ctx;
}

export interface SidebarProviderProps {
  children: ReactNode;
  defaultOpen?: boolean;
  /** Persist open/closed across reloads. */
  storageKey?: string;
  /** Global keyboard shortcut to toggle this sidebar. */
  shortcut?: ShortcutSpec;
}

export function SidebarProvider({
  children,
  defaultOpen = true,
  storageKey,
  shortcut,
}: SidebarProviderProps) {
  const [open, setOpenState] = useState<boolean>(() => {
    if (typeof window === "undefined" || !storageKey) return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return defaultOpen;
    return stored === "true";
  });

  const setOpen = useCallback(
    (v: boolean | ((p: boolean) => boolean)) => {
      setOpenState((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        if (storageKey && typeof window !== "undefined") {
          window.localStorage.setItem(storageKey, String(next));
        }
        return next;
      });
    },
    [storageKey]
  );

  const toggle = useCallback(() => setOpen((p) => !p), [setOpen]);

  useEffect(() => {
    if (!shortcut) return;
    const targetKey = shortcut.key.toLowerCase();
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== targetKey) return;
      const metaOK = shortcut.meta ? e.metaKey : !e.metaKey;
      const ctrlOK = shortcut.ctrl ? e.ctrlKey : !e.ctrlKey;
      const shiftOK = shortcut.shift ? e.shiftKey : !e.shiftKey;
      const altOK = shortcut.alt ? e.altKey : !e.altKey;
      // Allow either meta OR ctrl when both not specified strictly.
      const modifierOK =
        (shortcut.meta || shortcut.ctrl
          ? metaOK && ctrlOK
          : !e.metaKey && !e.ctrlKey) &&
        shiftOK &&
        altOK;
      if (!modifierOK) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut, toggle]);

  const value = useMemo(
    () => ({ open, setOpen, toggle, shortcut }),
    [open, setOpen, toggle, shortcut]
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export interface SidebarProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "left" | "right";
}

/**
 * A collapsible column. Width animates between collapsed (0) and a width
 * controlled by the caller via `w-*` utility classes on its container.
 */
export function Sidebar({
  className,
  children,
  side = "left",
  ...rest
}: SidebarProps) {
  const { open } = useSidebar();
  return (
    <aside
      data-state={open ? "expanded" : "collapsed"}
      data-side={side}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text)] transition-[width] duration-200 ease-out",
        "data-[state=collapsed]:w-0",
        side === "left" ? "border-r" : "border-l",
        className
      )}
      {...rest}
    >
      {/* Inner is rendered at the sidebar's natural width; overflow on the
          outer aside hides it when collapsed. */}
      <div className="flex h-full min-w-0 flex-1 flex-col">{children}</div>
    </aside>
  );
}

export function SidebarHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2",
        className
      )}
      {...rest}
    />
  );
}

export function SidebarContent({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
      {...rest}
    />
  );
}

export function SidebarFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2",
        className
      )}
      {...rest}
    />
  );
}

export function SidebarSection({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col", className)} {...rest} />;
}

export function SidebarSectionLabel({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "px-3 pt-3 pb-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]",
        className
      )}
      {...rest}
    />
  );
}

export interface SidebarTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export function SidebarTrigger({
  className,
  onClick,
  ...rest
}: SidebarTriggerProps) {
  const { toggle } = useSidebar();
  return (
    <button
      type="button"
      onClick={(e) => {
        toggle();
        onClick?.(e);
      }}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]",
        className
      )}
      aria-label="Toggle sidebar"
      {...rest}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>
  );
}
