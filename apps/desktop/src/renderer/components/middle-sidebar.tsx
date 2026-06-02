import { useEffect } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
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

export type WorkTab = "diffs" | "chat" | "plans";

interface Props {
  tab: WorkTab;
  onTabChange: (t: WorkTab) => void;

  repos: DiscoveredRepo[];
  repoGroups: RepoFileGroup[];
  selectedFile: { subPath: string; path: string } | null;
  onSelectFile: (subPath: string, path: string) => void;
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
    subPath: string
  ) => Promise<{ ok: boolean; error?: string }>;
  filesLoading: boolean;
  diffAvailable: boolean;

  sessions: SessionListItem[];
  selectedSession: string | null;
  onSelectSession: (id: string) => void;
  sessionsLoading: boolean;

  plans: Plan[];
  selectedPlan: string | null;
  onSelectPlan: (filePath: string) => void;

  projectsSidebarOpen: boolean;
}

function totalUnread(plans: Plan[]): number {
  return plans.reduce((s, p) => s + p.unread, 0);
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

export function MiddleSidebar({
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
  sessionsLoading,
  plans,
  selectedPlan,
  onSelectPlan,
  projectsSidebarOpen,
}: Props) {
  // ⌘1 / ⌘2 / ⌘3 → swap tabs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        onTabChange("diffs");
      } else if (e.key === "2") {
        e.preventDefault();
        onTabChange("chat");
      } else if (e.key === "3") {
        e.preventDefault();
        onTabChange("plans");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onTabChange]);

  const plansBadge = totalUnread(plans);
  const stagedGroups = repoGroups.filter((g) => g.staged.length > 0);
  const multiRepo = repos.length > 1;

  return (
    <Sidebar className="w-[280px]">
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as WorkTab)}
        className="flex h-full min-h-0 flex-col"
      >
        <SidebarHeader
          className={cn(
            "h-[52px] justify-center pr-3 pt-9 pb-2 [-webkit-app-region:drag]",
            projectsSidebarOpen ? "pl-3" : "pl-20"
          )}
        >
          <div className="[-webkit-app-region:no-drag]">
            <TabsList>
              <TabsTrigger value="diffs">Diffs</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
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
                      {multiRepo ? t.repoName : t.branch ?? ""}
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
    </Sidebar>
  );
}
