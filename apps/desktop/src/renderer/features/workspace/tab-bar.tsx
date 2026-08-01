import { forwardRef, memo, useEffect, useRef, type ReactNode } from "react";
import { NotebookPen } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import { basename } from "@plan/shared/lib/path";
import { FileIcon } from "@/renderer/components/file-icon";
import { WorkingIcon } from "@/renderer/features/sessions/working-icon";
import { useChatWorking } from "@/renderer/features/sessions/session-activity-store";
import type { Tab } from "./tabs-store";

function ChatIcon() {
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
      className="shrink-0"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function DiffIcon() {
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
      className="shrink-0"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function PrIcon() {
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
      className="shrink-0"
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v6" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M11 6l2-2-2-2" />
    </svg>
  );
}

function tabIcon(tab: Tab): ReactNode {
  switch (tab.kind) {
    case "chat":
      return <ChatIcon />;
    case "diff":
      return <DiffIcon />;
    case "file":
      return <FileIcon name={basename(tab.path)} />;
    case "pr":
      return <PrIcon />;
    case "scratch":
      return <NotebookPen size={13} className="shrink-0" />;
  }
}

export interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  /** Resolve a tab's display title from live data (session titles, etc.). */
  titleFor: (tab: Tab) => string;
  /**
   * Terminal id whose working-state drives this tab's icon (chat tabs only).
   * Return null for tabs with no agent, so the icon never animates.
   */
  termIdFor?: (tab: Tab) => string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * One content-pane tab. Split out so each can subscribe to its own session's
 * working-state (a hook, so it can't live inside the parent's `tabs.map`). While
 * the agent is busy the leading icon swaps to the animated WorkingIcon — same
 * fixed-size slot, so nothing shifts.
 */
const TabItem = forwardRef<
  HTMLDivElement,
  {
    tab: Tab;
    active: boolean;
    title: string;
    termId: string | null;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
  }
>(function TabItem({ tab, active, title, termId, onActivate, onClose }, ref) {
  const working = useChatWorking(termId);
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      title={title}
      onClick={() => onActivate(tab.id)}
      onMouseDown={(e) => {
        // Middle-click closes, matching browsers / editors.
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      className={cn(
        "group flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] transition-colors",
        active
          ? "bg-[var(--bg)] text-[var(--text)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-secondary)]",
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {working ? <WorkingIcon className="h-3.5 w-3.5" /> : tabIcon(tab)}
      </span>
      <span className="truncate">{title}</span>
      <span
        role="button"
        aria-label={`Close ${title}`}
        title="Close tab (⌘W)"
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className={cn(
          "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[13px] leading-none transition-opacity hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]",
          active
            ? "text-[var(--text-tertiary)]"
            : "opacity-0 group-hover:opacity-100",
        )}
      >
        ×
      </span>
    </div>
  );
});

/**
 * The strip of content-pane tabs above the editor. Each tab carries its own
 * mounted view below; this is purely the selector. Titles/icons are derived
 * from live data so a renamed chat or staged-state change reflects immediately.
 */
export const TabBar = memo(function TabBar({
  tabs,
  activeId,
  titleFor,
  termIdFor,
  onActivate,
  onClose,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view — whether it just got appended (opening a new
  // tab) or it's an existing tab that was scrolled off-screen (re-opening a
  // file already in a hidden tab). Only the strip scrolls, never an ancestor.
  useEffect(() => {
    const el = activeRef.current;
    const container = scrollRef.current;
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (elRect.left < cRect.left) {
      container.scrollLeft -= cRect.left - elRect.left;
    } else if (elRect.right > cRect.right) {
      container.scrollLeft += elRect.right - cRect.right;
    }
  }, [activeId, tabs.length]);

  if (tabs.length === 0) return null;
  return (
    <div
      ref={scrollRef}
      className="scrollbar-hover-x flex shrink-0 items-stretch overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-surface)]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <TabItem
            key={tab.id}
            ref={active ? activeRef : undefined}
            tab={tab}
            active={active}
            title={titleFor(tab)}
            termId={termIdFor ? termIdFor(tab) : null}
            onActivate={onActivate}
            onClose={onClose}
          />
        );
      })}
    </div>
  );
});
