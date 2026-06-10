import { memo, useEffect, useState } from "react";
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
import type { Plan, DiscoveredRepo } from "../../shared-types";
import { FileList, type RepoFileGroup } from "./file-list";
import { SessionList, type SessionListItem } from "./session-list";
import { PlansList } from "./plans-list";
import { CommitPanel } from "./commit-panel";
import { TerminalPanel } from "./terminal-panel";

export type WorkTab = "diffs" | "chat" | "plans";

interface Props {
  tab: WorkTab;
  onTabChange: (t: WorkTab) => void;

  repos: DiscoveredRepo[];
  repoGroups: RepoFileGroup[];
  selectedFile: { subPath: string; path: string; staged: boolean } | null;
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

  sessions: SessionListItem[];
  selectedSession: string | null;
  onSelectSession: (id: string) => void;
  onSetSessionArchived: (sessionId: string, archived: boolean) => void;
  onRenameSession: (sessionId: string, currentTitle: string) => void;
  onNewChat: () => void;
  sessionsLoading: boolean;

  plans: Plan[];
  selectedPlan: string | null;
  onSelectPlan: (filePath: string) => void;

  /** Project encoded dir — the embedded shells resolve their cwd from it. */
  encoded: string;
  terminals: { id: string; label: string }[];
  /** The shell shown in the embedded pane below the tab strip. */
  activeTerminalId: string | null;
  onNewTerminal: () => void;
  onSelectTerminal: (id: string) => void;
  onCloseTerminal: (id: string) => void;
}

function totalUnread(plans: Plan[]): number {
  return plans.reduce((s, p) => s + p.unread, 0);
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

/** Memoized so composer keystrokes in the workspace don't re-render the lists. */
export const MiddleSidebar = memo(function MiddleSidebar({
  tab,
  onTabChange,
  repos,
  repoGroups,
  selectedFile,
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
  sessions,
  selectedSession,
  onSelectSession,
  onSetSessionArchived,
  onRenameSession,
  onNewChat,
  sessionsLoading,
  plans,
  selectedPlan,
  onSelectPlan,
  encoded,
  terminals,
  activeTerminalId,
  onNewTerminal,
  onSelectTerminal,
  onCloseTerminal,
}: Props) {
  const sidebar = useSidebar();
  // Minimise the embedded terminal pane while keeping the tab strip visible.
  // Local UI state — independent of the dock and ⌘J.
  const [paneCollapsed, setPaneCollapsed] = useState(false);

  // ⌘1 / ⌘2 / ⌘3 → swap tabs (match the visual order: Chat, Diffs, Plans)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        onTabChange("chat");
      } else if (e.key === "2") {
        e.preventDefault();
        onTabChange("diffs");
      } else if (e.key === "3") {
        e.preventDefault();
        onTabChange("plans");
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

  const plansBadge = totalUnread(plans);
  const stagedGroups = repoGroups.filter((g) => g.staged.length > 0);
  const multiRepo = repos.length > 1;

  return (
    <Sidebar side="right" className="w-[280px]">
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as WorkTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <SidebarHeader className="h-[44px] justify-center px-3 pt-2 pb-2 [-webkit-app-region:drag]">
          <div className="[-webkit-app-region:no-drag]">
            <TabsList>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="diffs">Diffs</TabsTrigger>
              <TabsTrigger value="plans" className="relative">
                Plans
                {plansBadge > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-semibold text-[var(--bg)]">
                    {plansBadge}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
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
                {/* Commit message lives at the TOP, VS Code style. */}
                {stagedGroups.map((g) => {
                  const repo = repos.find((r) => r.subPath === g.subPath);
                  return (
                    <CommitPanel
                      key={g.subPath || "/"}
                      stagedCount={g.staged.length}
                      branch={repo?.branch ?? null}
                      repoLabel={multiRepo ? g.repoName : null}
                      onCommit={(msg) => onCommit(msg, g.subPath)}
                    />
                  );
                })}
                <div className="min-h-0 flex-1">
                  <FileList
                    groups={repoGroups}
                    selected={selectedFile}
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
                    className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-[var(--bg-surface)]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <UploadIcon />
                      <span className="truncate">
                        {t.pushing
                          ? "Pushing…"
                          : !t.hasUpstream
                            ? "Publish branch"
                            : t.ahead > 0
                              ? `Push ${t.ahead}`
                              : "Up to date"}
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
              onSelect={onSelectSession}
              onSetArchived={onSetSessionArchived}
              onRename={onRenameSession}
              onNewChat={onNewChat}
              loading={sessionsLoading}
            />
          </TabsContent>

          <TabsContent
            value="plans"
            forceMount
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <PlansList
              plans={plans}
              selected={selectedPlan}
              onSelect={onSelectPlan}
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
              className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
            >
              <ChevronIcon up={paneCollapsed} />
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto">
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
                      : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  )}
                >
                  <span>{t.label}</span>
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
                        : "opacity-0 group-hover:opacity-100"
                    )}
                  >
                    ×
                  </span>
                </button>
              );
            })}
            {/* Immediately right of the last tab; scrolls with the strip. */}
            <button
              onClick={onNewTerminal}
              title="New terminal (⌘⇧J)"
              aria-label="New terminal"
              className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
            >
              <PlusIcon />
            </button>
          </div>
        </div>
        {/* Embedded terminal pane: the active shell renders right here, sized
            to this bottom section only. All opened shells stay mounted
            (hidden) so their scrollback survives tab switches and minimise. */}
        {terminals.length > 0 && (
          <div
            className={cn(
              "relative border-t border-[var(--border)] transition-all duration-200",
              paneCollapsed ? "h-0 border-t-0" : "h-72"
            )}
          >
            {terminals.map((t) => {
              const active = t.id === activeTerminalId;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "absolute inset-0 overflow-hidden",
                    (!active || paneCollapsed) && "hidden"
                  )}
                >
                  <TerminalPanel
                    id={t.id}
                    encoded={encoded}
                    showHeader={false}
                    visible={active && !paneCollapsed && sidebar.open}
                    onRequestClose={() => onCloseTerminal(t.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Sidebar>
  );
});
