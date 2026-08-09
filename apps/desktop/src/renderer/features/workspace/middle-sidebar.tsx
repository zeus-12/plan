import { memo, useEffect, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";
import {
  TextShimmer,
  onAccentShimmer,
} from "@plan/shared/components/ui/text-shimmer";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@plan/shared/components/ui/tabs";
import { cn } from "@plan/shared/lib/utils";
import type { CommandEntry, DiscoveredRepo } from "@/common/shared-types";
import {
  FileList,
  type RepoFileGroup,
} from "@/renderer/features/git/file-list";
import {
  SessionList,
  type SessionListItem,
} from "@/renderer/features/sessions/session-list";
import { ProjectFileList } from "@/renderer/features/files/project-file-list";
import { CommitPanel } from "@/renderer/features/git/commit-panel";
import { TerminalPanel } from "@/renderer/features/terminal/terminal-panel";
import { CommandsTerminal } from "@/renderer/features/terminal/commands-terminal";
import { SearchPanel } from "@/renderer/features/search/search-panel";
import { PrSidebar } from "@/renderer/features/pr/pr-sidebar";
import { usePersistentNumber } from "@/renderer/lib/use-persistent-number";
import { useEdgeFade } from "@/renderer/lib/use-edge-fade";

import type { WorkTab } from "./use-workspace-tabs";

export type { WorkTab };

interface Props {
  tab: WorkTab;
  onTabChange: (t: WorkTab) => void;

  repos: DiscoveredRepo[];
  repoGroups: RepoFileGroup[];
  selectedFile: { subPath: string; path: string; staged: boolean } | null;
  /** Project-relative path of the current file of interest, shared across the
   * Diffs and Files tabs so each highlights it (cross-tab indicator). */
  activeFilePath: string | null;
  onSelectFile: (subPath: string, path: string, staged: boolean) => void;
  onStageFile: (path: string, subPath: string) => void;
  onUnstageFile: (path: string, subPath: string) => void;
  onDiscardFile: (path: string, subPath: string) => void;
  onStageAll: (subPath: string) => void;
  onUnstageAll: (subPath: string) => void;
  onDiscardAll: (subPath: string) => void;
  onStashAll: (subPath: string) => void;
  syncTargets: {
    subPath: string;
    repoName: string;
    branch: string | null;
    ahead: number;
    hasUpstream: boolean;
    pushing: boolean;
  }[];
  onPush: (subPath: string) => void;
  onCommit: (
    message: string,
    subPath: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  filesLoading: boolean;
  diffAvailable: boolean;
  /** A manual (⌘R) git re-read is in flight — shimmers the Diffs tab label. */
  diffsRefreshing: boolean;

  sessions: SessionListItem[];
  selectedSession: string | null;
  onSelectSession: (id: string) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
  onRenameSession: (sessionId: string, currentTitle: string) => void;
  onMoveSession?: (sessionId: string, title: string) => void;
  onNewChat: () => void;
  sessionsLoading: boolean;

  projectFiles: string[];
  projectFilesLoading: boolean;
  selectedProjectFile: string | null;
  onSelectProjectFile: (path: string) => void;
  /** Open a project-wide search hit: relative path + 1-based line + char range. */
  onOpenSearchResult: (
    path: string,
    line: number,
    colStart: number,
    colEnd: number,
  ) => void;

  /** The PR currently open in the content pane, for the PR list's highlight. */
  activePr: { subPath: string; number: number } | null;
  /** Open a PR in the content pane. */
  onOpenPr: (subPath: string, number: number) => void;
  /** Display name for a repo row in the PR list. */
  repoName: (repo: DiscoveredRepo) => string;

  /** Project encoded dir — the embedded shells resolve their cwd from it. */
  encoded: string;
  /** Run (always) + Build (worktree only) are first and non-closable; rest are shells. */
  terminals: {
    id: string;
    label: string;
    kind: "run" | "build" | "shell";
    /** Runs once, when this shell's pty is created (a chat code block's run
     *  button spawns the shell already carrying its command). */
    initialCommand?: string;
  }[];
  /** The shell shown in the embedded pane below the tab strip. */
  activeTerminalId: string | null;
  onNewTerminal: () => void;
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
  /** Bumped when a shell was spawned from outside this sidebar — reveals the
   *  terminal pane so the new shell is actually on screen. */
  terminalRevealTick: number;
  /** Project-level Run command list (shared across worktrees). */
  runEntries: CommandEntry[];
  /** Project-level Build command list (surfaced only in a worktree). */
  buildEntries: CommandEntry[];
  /** Open the terminal settings, landing on one section. */
  onOpenCommandSettings: (section: "run" | "build") => void;
  /** Open the per-worktree scratchpad as a tab in the center content pane. */
  onOpenScratch: () => void;
}

function ChevronIcon({ up }: { up: boolean }) {
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
      className={cn("transition-transform duration-200", up && "rotate-180")}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function GearIcon() {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PlusIcon() {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function UploadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/**
 * The work-tab strip. The sidebar can be dragged narrower than the strip's
 * intrinsic width, so it scrolls sideways; the fades are driven by the measured
 * scroll position (never assumed), and the active tab is scrolled into view so
 * a tab is never selected-but-hidden.
 */
function WorkTabStrip({
  tab,
  diffsRefreshing,
}: {
  tab: WorkTab;
  diffsRefreshing: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      // 1px slack: fractional widths leave sub-pixel remainders at the ends.
      const maxScroll = el.scrollWidth - el.clientWidth;
      setEdges((prev) => {
        const next = {
          start: el.scrollLeft > 1,
          end: el.scrollLeft < maxScroll - 1,
        };
        return prev.start === next.start && prev.end === next.end ? prev : next;
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const active = scrollerRef.current?.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    );
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollerRef}
        className="overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Auto margins center it while it fits and collapse to 0 once it
            overflows, so the first tab is never scrolled out of reach. */}
        <TabsList className="mx-auto w-max">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="diffs">
            {/* Shimmer rather than an icon: it's the app's existing "working"
                language and costs no width, so the strip can't shift. */}
            {diffsRefreshing ? (
              // Only reachable while this tab is active, i.e. on the accent
              // fill — the theme's text tokens would be invisible there.
              <TextShimmer duration={1.2} style={onAccentShimmer}>
                Diffs
              </TextShimmer>
            ) : (
              "Diffs"
            )}
          </TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="pr">PR</TabsTrigger>
        </TabsList>
      </div>
      {edges.start && (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--bg-chrome,var(--bg-surface))] to-transparent" />
      )}
      {edges.end && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--bg-chrome,var(--bg-surface))] to-transparent" />
      )}
    </div>
  );
}

/** Memoized so composer keystrokes in the workspace don't re-render the lists. */
export const MiddleSidebar = memo(function MiddleSidebar({
  tab,
  onTabChange,
  repos,
  repoGroups,
  selectedFile,
  activeFilePath,
  onSelectFile,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onStashAll,
  syncTargets,
  onPush,
  onCommit,
  filesLoading,
  diffAvailable,
  diffsRefreshing,
  sessions,
  selectedSession,
  onSelectSession,
  onSetSessionArchived,
  onRenameSession,
  onMoveSession,
  onNewChat,
  sessionsLoading,
  projectFiles,
  projectFilesLoading,
  selectedProjectFile,
  onSelectProjectFile,
  onOpenSearchResult,
  activePr,
  onOpenPr,
  repoName,
  encoded,
  terminals,
  activeTerminalId,
  onNewTerminal,
  onSelectTerminal,
  onCloseTerminal,
  terminalRevealTick,
  runEntries,
  buildEntries,
  onOpenCommandSettings,
  onOpenScratch,
}: Props) {
  const sidebar = useSidebar();
  // Minimise the embedded terminal pane while keeping the tab strip visible.
  // Local UI state — independent of the dock and ⌘J.
  const [paneCollapsed, setPaneCollapsed] = useState(false);
  const [width, setWidth] = usePersistentNumber(
    "plan.middleSidebar.width",
    280,
  );
  const [termHeight, setTermHeight] = usePersistentNumber(
    "plan.middleSidebar.termHeight",
    288, // current h-72
  );
  // Bumped when the sidebar's open/close width animation finishes so the embedded
  // terminal refits to the settled width. The width animates through slivers
  // during the toggle; fitting on those intermediate frames leaves the pty (and
  // Claude's TUI) stuck a couple of columns wide once the animation ends.
  const [fitSignal, setFitSignal] = useState(0);
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  // Tabs scroll under the pinned settings gear, so the strip's ends dissolve
  // rather than being cut mid-label.
  const stripFade = useEdgeFade(terminals.length);
  // The gear opens the section the visible terminal belongs to; a scratch shell
  // has no command list of its own, so it falls back to Run.
  const activeTerminalKind =
    terminals.find((t) => t.id === activeTerminalId)?.kind ?? "run";

  const startTermResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = termHeight;
    const onMove = (ev: PointerEvent) => {
      // Drag up grows the terminal (it's pinned to the bottom).
      const next = Math.min(Math.max(startH - (ev.clientY - startY), 120), 700);
      setTermHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ⌘1‑⌘5 → swap tabs (match the visual order); ⌘⇧F → Search (VS Code binding).
  // Cmd only, not Ctrl — Ctrl+digit stays free of app bindings.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey) return;
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        onTabChange("search");
        setSearchFocusSignal((v) => v + 1);
        return;
      }
      if (e.shiftKey) return;
      if (e.key === "1") {
        e.preventDefault();
        onTabChange("chat");
      } else if (e.key === "2") {
        e.preventDefault();
        onTabChange("diffs");
      } else if (e.key === "3") {
        e.preventDefault();
        onTabChange("files");
      } else if (e.key === "4") {
        e.preventDefault();
        onTabChange("search");
      } else if (e.key === "5") {
        e.preventDefault();
        onTabChange("pr");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onTabChange]);

  // ⌘T → toggle the embedded terminal pane (⌘J stays the coding-agent dock).
  // Reveals a hidden sidebar and spawns a first shell when there are none, so
  // one keystroke always lands you in a terminal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.altKey ||
        e.key.toLowerCase() !== "t"
      )
        return;
      e.preventDefault();
      const wasOpen = sidebar.open;
      if (!wasOpen) sidebar.setOpen(true);
      if (terminals.length === 0) {
        onNewTerminal();
        setPaneCollapsed(false);
      } else if (!wasOpen) {
        setPaneCollapsed(false);
      } else {
        setPaneCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sidebar, terminals.length, onNewTerminal]);

  // A shell spawned elsewhere (the run button on a chat code block) has no way
  // to open this pane itself. Compared against the tick we last acted on rather
  // than firing on mount, so a workspace remount doesn't pop the pane open for
  // a shell that was spawned long ago.
  const lastRevealTick = useRef(terminalRevealTick);
  useEffect(() => {
    if (terminalRevealTick === lastRevealTick.current) return;
    lastRevealTick.current = terminalRevealTick;
    sidebar.setOpen(true);
    setPaneCollapsed(false);
  }, [terminalRevealTick, sidebar]);

  const multiRepo = repos.length > 1;
  // Commit drafts live here, keyed by repo subPath, so a draft survives its
  // commit box unmounting as the virtualized file list scrolls.
  const [commitDrafts, setCommitDrafts] = useState<Record<string, string>>({});
  const setDraft = (key: string, message: string) =>
    setCommitDrafts((prev) => ({ ...prev, [key]: message }));

  return (
    <Sidebar
      className="plan-right-sidebar"
      side="right"
      width={width}
      onWidthChange={setWidth}
      minWidth={220}
      maxWidth={520}
      onWidthTransitionEnd={() => setFitSignal((n) => n + 1)}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as WorkTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SidebarHeader className="h-[44px] px-3 pt-2 pb-2 [-webkit-app-region:drag]">
          <div className="flex w-full min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
            <WorkTabStrip tab={tab} diffsRefreshing={diffsRefreshing} />
            {/* Detached from the tab group: opens the scratchpad as a center-pane
                tab rather than switching this sidebar's view. */}
            <button
              onClick={onOpenScratch}
              title="Open scratchpad"
              aria-label="Open scratchpad"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
            >
              <NotebookPen size={15} />
            </button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <TabsContent
            value="diffs"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            {!diffAvailable ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                Not a git repo
              </div>
            ) : filesLoading ? (
              <div className="flex flex-1 items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                Loading…
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Each repo's commit box sits directly above its own files. */}
                <div className="min-h-0 flex-1">
                  <FileList
                    groups={repoGroups}
                    renderCommit={(g) => {
                      const repo = repos.find((r) => r.subPath === g.subPath);
                      const key = g.subPath || "/";
                      return (
                        <CommitPanel
                          stagedCount={g.staged.length}
                          branch={repo?.branch ?? null}
                          repoLabel={multiRepo ? g.repoName : null}
                          message={commitDrafts[key] ?? ""}
                          onMessageChange={(msg) => setDraft(key, msg)}
                          onCommit={(msg) => onCommit(msg, g.subPath)}
                        />
                      );
                    }}
                    selected={selectedFile}
                    activeFilePath={activeFilePath}
                    onSelect={onSelectFile}
                    onStage={onStageFile}
                    onUnstage={onUnstageFile}
                    onDiscard={onDiscardFile}
                    onStageAll={onStageAll}
                    onUnstageAll={onUnstageAll}
                    onDiscardAll={onDiscardAll}
                    onStashAll={onStashAll}
                  />
                </div>
                {/* Push / sync bar pinned at the bottom. */}
                {syncTargets.map((t) => (
                  <button
                    key={t.subPath || "/"}
                    onClick={() => onPush(t.subPath)}
                    disabled={t.pushing || (t.hasUpstream && t.ahead === 0)}
                    className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--bg-chrome,var(--bg-surface))] px-3 py-2 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--row-hover)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-[var(--bg-chrome,var(--bg-surface))]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <UploadIcon />
                      <span className="truncate">
                        {t.pushing ? (
                          <TextShimmer duration={2.4}>Pushing…</TextShimmer>
                        ) : !t.hasUpstream ? (
                          "Publish branch"
                        ) : t.ahead > 0 ? (
                          `Pull & push ${t.ahead}`
                        ) : (
                          "Up to date"
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 truncate text-[10px] text-[var(--text-tertiary)]">
                      {multiRepo ? t.repoName : (t.branch ?? "")}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="chat"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <SessionList
              sessions={sessions}
              selected={selectedSession}
              encoded={encoded}
              onSelect={onSelectSession}
              onSetArchived={onSetSessionArchived}
              onRename={onRenameSession}
              onMoveSession={onMoveSession}
              onNewChat={onNewChat}
              loading={sessionsLoading}
            />
          </TabsContent>

          <TabsContent
            value="files"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <ProjectFileList
              files={projectFiles}
              selected={selectedProjectFile}
              activeFilePath={activeFilePath}
              onSelect={onSelectProjectFile}
              loading={projectFilesLoading}
            />
          </TabsContent>

          <TabsContent
            value="search"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <SearchPanel
              encoded={encoded}
              active={tab === "search"}
              focusSignal={searchFocusSignal}
              onOpenResult={onOpenSearchResult}
            />
          </TabsContent>

          <TabsContent
            value="pr"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <PrSidebar
              encoded={encoded}
              repos={repos}
              repoName={repoName}
              activePr={activePr}
              onOpenPr={onOpenPr}
            />
          </TabsContent>
        </SidebarContent>
      </Tabs>

      {/* ── Terminals: always-present tab strip + embedded pane ── */}
      <div className="shrink-0 border-t border-[var(--border)]">
        <div className="flex items-stretch gap-2 px-3 pt-2">
          {terminals.length > 0 && (
            <button
              onClick={() => setPaneCollapsed((v) => !v)}
              title={paneCollapsed ? "Expand terminal" : "Minimise terminal"}
              aria-label={
                paneCollapsed ? "Expand terminal" : "Minimise terminal"
              }
              className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
            >
              <ChevronIcon up={paneCollapsed} />
            </button>
          )}
          <div
            ref={stripFade.ref}
            onScroll={stripFade.onScroll}
            style={{
              maskImage: stripFade.mask,
              WebkitMaskImage: stripFade.mask,
            }}
            className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto"
          >
            {terminals.map((t) => {
              const active = t.id === activeTerminalId;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    onSelectTerminal(t.id);
                    setPaneCollapsed(false);
                  }}
                  className={cn(
                    "group flex shrink-0 items-center gap-1.5 border-b-2 pb-1.5 font-[family-name:var(--font-mono)] text-[11px] transition-colors",
                    active && !paneCollapsed
                      ? "border-[var(--text)] text-[var(--text)]"
                      : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  <span>{t.label}</span>
                  {t.kind === "shell" && (
                    <span
                      role="button"
                      aria-label={`Close ${t.label}`}
                      title="Close terminal"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTerminal(t.id);
                      }}
                      className={cn(
                        "-mr-0.5 flex h-3.5 w-3.5 items-center justify-center rounded text-[12px] leading-none transition-opacity hover:text-[var(--text)]",
                        active
                          ? "text-[var(--text-tertiary)]"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      ×
                    </span>
                  )}
                </button>
              );
            })}
            {/* Immediately right of the last tab; scrolls with the strip. */}
            <button
              onClick={() => {
                // Spawning already switches to the new terminal; make sure the
                // pane is expanded so a collapsed terminal section reopens too.
                onNewTerminal();
                setPaneCollapsed(false);
              }}
              title="New terminal (⌘⇧T)"
              aria-label="New terminal"
              className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
            >
              <PlusIcon />
            </button>
          </div>
          {/* The one way into the command settings, pinned outside the scroller
              so the tabs slide under it and fade out rather than reach it. */}
          <button
            onClick={() =>
              onOpenCommandSettings(
                activeTerminalKind === "build" ? "build" : "run",
              )
            }
            title="Terminal commands"
            aria-label="Terminal commands"
            className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
          >
            <GearIcon />
          </button>
        </div>
        {/* Embedded terminal pane: the active shell renders right here, sized
            to this bottom section only (drag the top edge to resize). All opened
            shells stay mounted (hidden) so scrollback survives tab switches. */}
        {terminals.length > 0 && (
          <div
            className={cn(
              "relative border-t border-[var(--border)]",
              paneCollapsed && "border-t-0",
            )}
            style={{ height: paneCollapsed ? 0 : termHeight }}
          >
            {!paneCollapsed && (
              <div
                onPointerDown={startTermResize}
                title="Drag to resize"
                className="absolute inset-x-0 top-0 z-20 h-1 cursor-row-resize transition-colors hover:bg-[var(--border-strong)]"
              />
            )}
            {terminals.map((t) => {
              const active = t.id === activeTerminalId;
              const commandKind = t.kind === "shell" ? null : t.kind;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "absolute inset-0 overflow-hidden",
                    (!active || paneCollapsed) && "hidden",
                  )}
                >
                  {commandKind ? (
                    <CommandsTerminal
                      kind={commandKind}
                      encoded={encoded}
                      entries={
                        commandKind === "build" ? buildEntries : runEntries
                      }
                      repos={repos}
                      visible={active && !paneCollapsed && sidebar.open}
                      fitSignal={fitSignal}
                      onConfigure={() => onOpenCommandSettings(commandKind)}
                    />
                  ) : (
                    <TerminalPanel
                      id={t.id}
                      encoded={encoded}
                      initialCommand={t.initialCommand}
                      showHeader={false}
                      visible={active && !paneCollapsed && sidebar.open}
                      fitSignal={fitSignal}
                      onRequestClose={() => onCloseTerminal(t.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Sidebar>
  );
});
