import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import { parseUnifiedDiff, type FileDiff } from "@plan/shared/lib/diff-parser";
import { MessageOutput } from "@plan/shared/components/message-output";
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { useTheme } from "@plan/shared/components/theme-provider";
import { cn } from "@plan/shared/lib/utils";
import type {
  ProjectEntry,
  ParsedSession,
  Plan,
  GitFileStatus,
  DiscoveredRepo,
} from "../../shared-types";
import { MiddleSidebar, type WorkTab } from "./middleSidebar";
import { FileDiffViewer } from "./fileDiffViewer";
import { MessageList, type ChatAnnotation } from "./messageList";
import { PlanViewer } from "./planViewer";
import { useConfirm } from "./confirmDialog";
import type { SessionListItem } from "./sessionList";
import type { FileEntry, RepoFileGroup } from "./fileList";

interface Props {
  project: ProjectEntry;
  repos: DiscoveredRepo[];
  projectsSidebarOpen: boolean;
  onToggleProjectSidebar: () => void;
}

const MAX_SESSIONS = 5;

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

function WorkspaceHeader({
  project,
  projectsSidebarOpen,
  onToggleProjectSidebar,
  branch,
}: {
  project: ProjectEntry;
  projectsSidebarOpen: boolean;
  onToggleProjectSidebar: () => void;
  branch: string | null;
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const middle = useSidebar();
  const shortName =
    project.cwd.split("/").filter(Boolean).pop() ?? project.cwd;

  return (
    <header
      className={cn(
        "flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] pr-3 pt-9 pb-2 [-webkit-app-region:drag]",
        // Pad past macOS traffic-light area when this header is the leftmost pane.
        projectsSidebarOpen ? "pl-3" : "pl-20"
      )}
    >
      <div className="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleProjectSidebar}
              aria-label="Toggle projects sidebar"
            >
              <ToggleIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-1.5">
            <span>Projects</span>
            <Kbd keys={["⌘", "B"]} />
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-w-0 flex-1 items-baseline justify-center gap-2 px-3">
        <span className="truncate font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          {shortName}
        </span>
        {branch && (
          <span className="shrink-0 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-secondary)]">
            ⎇ {branch}
          </span>
        )}
        <span className="hidden truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] sm:inline">
          {project.cwd}
        </span>
      </div>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-1.5">
            <span>{middle.open ? "Hide" : "Show"} files & chat</span>
            <Kbd keys={["⌘", "E"]} />
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={toggleTheme}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function ToggleIcon() {
  return (
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
  );
}

export function ProjectWorkspace({
  project,
  repos,
  projectsSidebarOpen,
  onToggleProjectSidebar,
}: Props) {
  // Headline branch: when a project has multiple repos we just show the first.
  const branch = repos[0]?.branch ?? null;
  const [tab, setTab] = useState<WorkTab>("diffs");
  const { confirm, dialog: confirmDialog } = useConfirm();

  // ── Files state (per-repo) ───────────────────────────────────
  interface RepoFiles {
    files: FileDiff[];
    status: GitFileStatus[];
    diffAvailable: boolean;
  }
  const [filesByRepo, setFilesByRepo] = useState<Map<string, RepoFiles>>(
    new Map()
  );
  const [filesLoading, setFilesLoading] = useState(true);
  // True once the first load has populated data. Subsequent refreshes (after a
  // stage/discard/etc.) update in place WITHOUT flipping back to the loading
  // placeholder — that swap unmounts the list and resets its scroll.
  const loadedRef = useRef(false);
  /** Selected file is identified by both its repo (subPath) and its path. */
  const [selectedFile, setSelectedFile] = useState<
    { subPath: string; path: string } | null
  >(null);
  /** Annotations keyed by "subPath::path" so they don't collide across repos. */
  const [annotationsByFile, setAnnotationsByFile] = useState<
    Record<string, Annotation[]>
  >({});

  const refreshDiff = useCallback(async () => {
    if (repos.length === 0) {
      setFilesByRepo(new Map());
      setFilesLoading(false);
      loadedRef.current = true;
      return;
    }
    if (!loadedRef.current) setFilesLoading(true);
    try {
      const entries = await Promise.all(
        repos.map(async (r) => {
          const [diff, status] = await Promise.all([
            window.electronAPI.getDiff(project.encoded, r.subPath),
            window.electronAPI.getGitStatus(project.encoded, r.subPath),
          ]);
          return [
            r.subPath,
            {
              files: diff.available ? parseUnifiedDiff(diff.diff) : [],
              status: status.files,
              diffAvailable: diff.available,
            },
          ] as const;
        })
      );
      const next = new Map(entries);
      setFilesByRepo(next);
      setSelectedFile((current) => {
        // Keep the current selection if it still exists.
        if (current) {
          const repo = next.get(current.subPath);
          if (
            repo &&
            (repo.files.some((f) => f.path === current.path) ||
              repo.status.some((s) => s.path === current.path))
          ) {
            return current;
          }
        }
        // Otherwise pick the first available file from any repo.
        for (const r of repos) {
          const repo = next.get(r.subPath);
          if (!repo) continue;
          const first = repo.files[0]?.path ?? repo.status[0]?.path ?? null;
          if (first) return { subPath: r.subPath, path: first };
        }
        return null;
      });
    } finally {
      loadedRef.current = true;
      setFilesLoading(false);
    }
  }, [project.encoded, repos]);

  /**
   * Per-repo {staged, unstaged} groups for the sidebar file list. Built from
   * each repo's status + diff. When there's only one repo we still produce
   * one group; the FileList collapses single-group rendering to flat.
   */
  const repoGroups: RepoFileGroup[] = useMemo(() => {
    return repos.map((repo) => {
      const state = filesByRepo.get(repo.subPath);
      if (!state) {
        return {
          subPath: repo.subPath,
          repoName: repoDisplayName(repo, project.cwd),
          staged: [],
          unstaged: [],
          diffAvailable: true,
        };
      }
      const diffByPath = new Map(state.files.map((f) => [f.path, f]));
      const staged: FileEntry[] = [];
      const unstaged: FileEntry[] = [];
      for (const s of state.status) {
        const diff = diffByPath.get(s.path);
        const letter = letterFromCode(s.code) ?? letterFromDiff(diff);
        const base = {
          path: s.path,
          code: s.code,
          letter,
          additions: diff?.additions,
          deletions: diff?.deletions,
          subPath: repo.subPath,
        };
        if (s.staged) staged.push({ ...base, staged: true });
        if (s.unstaged) unstaged.push({ ...base, staged: false });
      }
      return {
        subPath: repo.subPath,
        repoName: repoDisplayName(repo, project.cwd),
        staged,
        unstaged,
        diffAvailable: state.diffAvailable,
      };
    });
  }, [repos, filesByRepo, project.cwd]);

  // For diff-annotation aggregation (kept global so the copy box at the
  // bottom shows everything regardless of which file is selected).
  const aggregatedDiffAnnotations = useMemo(
    () => Object.values(annotationsByFile).flat(),
    [annotationsByFile]
  );

  // ── Git actions (routed via subPath) ─────────────────────────
  const handleStageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.stageFile(
        project.encoded,
        path,
        subPath
      );
      if (!res.ok) console.warn("stage failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff]
  );

  const handleUnstageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.unstageFile(
        project.encoded,
        path,
        subPath
      );
      if (!res.ok) console.warn("unstage failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff]
  );

  const handleDiscardFile = useCallback(
    async (path: string, subPath: string) => {
      const ok = await confirm({
        title: `Discard changes to ${path.split("/").pop() ?? path}?`,
        description:
          "This permanently discards your local changes to this file. It cannot be undone.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
      const res = await window.electronAPI.discardFile(
        project.encoded,
        path,
        subPath
      );
      if (!res.ok) console.warn("discard failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff, confirm]
  );

  const handleStageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.stageAll(project.encoded, subPath);
      if (!res.ok) console.warn("stage all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff]
  );

  const handleUnstageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.unstageAll(project.encoded, subPath);
      if (!res.ok) console.warn("unstage all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff]
  );

  const handleCommit = useCallback(
    async (message: string, subPath: string) => {
      const res = await window.electronAPI.commit(
        project.encoded,
        message,
        subPath
      );
      if (!res.ok) return { ok: false, error: res.error ?? "Commit failed" };
      refreshDiff();
      return { ok: true };
    },
    [project.encoded, refreshDiff]
  );

  useEffect(() => {
    setAnnotationsByFile({});
    setSelectedFile(null);
    refreshDiff();
  }, [refreshDiff]);

  // ── Sessions state ───────────────────────────────────────────
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<ParsedSession | null>(null);
  const [chatAnnotations, setChatAnnotations] = useState<ChatAnnotation[]>([]);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const list = await window.electronAPI.listSessions(project.encoded);
      const top = list.slice(0, MAX_SESSIONS);
      const enriched: SessionListItem[] = await Promise.all(
        top.map(async (s) => {
          const parsed = await window.electronAPI.readSession(
            project.encoded,
            s.sessionId
          );
          return {
            sessionId: s.sessionId,
            title: parsed?.meta.title ?? null,
            updatedAt: parsed?.meta.updatedAt ?? s.mtimeMs,
            messageCount: parsed?.meta.messageCount ?? 0,
          };
        })
      );
      setSessions(enriched);
      setSelectedSessionId((current) => {
        if (current && enriched.some((s) => s.sessionId === current))
          return current;
        return enriched[0]?.sessionId ?? null;
      });
    } finally {
      setSessionsLoading(false);
    }
  }, [project.encoded]);

  const refreshSelectedSession = useCallback(async () => {
    if (!selectedSessionId) {
      setSession(null);
      return;
    }
    const parsed = await window.electronAPI.readSession(
      project.encoded,
      selectedSessionId
    );
    setSession(parsed);
  }, [project.encoded, selectedSessionId]);

  useEffect(() => {
    setChatAnnotations([]);
    setSelectedSessionId(null);
    setSession(null);
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    refreshSelectedSession();
  }, [refreshSelectedSession]);

  // Watcher: re-pull what's relevant.
  useEffect(() => {
    return window.electronAPI.onWatcherEvent((e) => {
      if (e.encoded !== project.encoded) return;
      refreshDiff();
      refreshSessions();
      if (e.sessionId && e.sessionId === selectedSessionId) {
        refreshSelectedSession();
      }
    });
  }, [
    project.encoded,
    selectedSessionId,
    refreshDiff,
    refreshSessions,
    refreshSelectedSession,
  ]);

  // ── Plans state (global, not project-scoped) ─────────────────
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlanPath, setSelectedPlanPath] = useState<string | null>(null);

  const refreshPlans = useCallback(async () => {
    const list = await window.electronAPI.listPlans();
    setPlans(list);
  }, []);

  useEffect(() => {
    refreshPlans();
    return window.electronAPI.onPlansEvent(() => {
      refreshPlans();
    });
  }, [refreshPlans]);

  const handleSelectPlan = useCallback(
    async (filePath: string) => {
      setSelectedPlanPath(filePath);
      await window.electronAPI.markPlanRead(filePath);
      // Re-pull so the unread badge clears immediately.
      refreshPlans();
    },
    [refreshPlans]
  );

  const selectedPlan = useMemo(
    () => plans.find((p) => p.filePath === selectedPlanPath) ?? null,
    [plans, selectedPlanPath]
  );

  // ── Aggregated annotations ───────────────────────────────────
  const aggregatedChatAnnotations = useMemo<Annotation[]>(
    () =>
      chatAnnotations.map((c) => ({
        id: c.id,
        selectedText: c.selectedText,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        comment: c.comment,
        side: "right",
      })),
    [chatAnnotations]
  );

  // ── Chat annotation handlers ─────────────────────────────────
  const addChatAnnotation = useCallback(
    (
      messageUuid: string,
      partIndex: number,
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string
    ) => {
      setChatAnnotations((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          messageUuid,
          partIndex,
          selectedText,
          startOffset,
          endOffset,
          comment,
        },
      ]);
    },
    []
  );
  const updateChatAnnotation = useCallback(
    (id: string, comment: string) => {
      setChatAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, comment } : a))
      );
    },
    []
  );
  const removeChatAnnotation = useCallback((id: string) => {
    setChatAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /**
   * The FileDiff for the currently-selected file. Untracked files (and any
   * status entry that `git diff HEAD` doesn't emit) get a synthetic FileDiff
   * so they still open in the viewer — FileDiffViewer fetches the actual
   * content itself via getFileContents.
   */
  const selectedFileDiff = useMemo<FileDiff | null>(() => {
    if (!selectedFile) return null;
    const repo = filesByRepo.get(selectedFile.subPath);
    if (!repo) return null;
    const fromDiff = repo.files.find((f) => f.path === selectedFile.path);
    if (fromDiff) return fromDiff;

    // Not in the diff — synthesize from the status entry.
    const status = repo.status.find((s) => s.path === selectedFile.path);
    if (!status) return null;
    const isDeleted = status.code.includes("D");
    const isUntracked = status.code === "??";
    const statusKind: FileDiff["status"] = isDeleted
      ? "deleted"
      : isUntracked
        ? "added"
        : "modified";
    return {
      path: selectedFile.path,
      oldPath: isUntracked ? null : selectedFile.path,
      newPath: isDeleted ? null : selectedFile.path,
      status: statusKind,
      body: "",
      additions: 0,
      deletions: 0,
      binary: false,
    };
  }, [selectedFile, filesByRepo]);

  const handleSelectFile = useCallback((subPath: string, path: string) => {
    setSelectedFile({ subPath, path });
  }, []);

  return (
    <SidebarProvider
      defaultOpen={true}
      storageKey="plan.middleSidebar.open"
      shortcut={{ key: "e", meta: true }}
    >
      {confirmDialog}
      <div className="flex h-full w-full flex-row">
        <MiddleSidebar
          tab={tab}
          onTabChange={setTab}
          repos={repos}
          repoGroups={repoGroups}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
          onStageFile={handleStageFile}
          onUnstageFile={handleUnstageFile}
          onDiscardFile={handleDiscardFile}
          onStageAll={handleStageAll}
          onUnstageAll={handleUnstageAll}
          onCommit={handleCommit}
          filesLoading={filesLoading}
          diffAvailable={repos.length > 0}
          sessions={sessions}
          selectedSession={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          sessionsLoading={sessionsLoading}
          plans={plans}
          selectedPlan={selectedPlanPath}
          onSelectPlan={handleSelectPlan}
          projectsSidebarOpen={projectsSidebarOpen}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceHeader
            project={project}
            projectsSidebarOpen={projectsSidebarOpen}
            onToggleProjectSidebar={onToggleProjectSidebar}
            branch={branch}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {tab === "diffs" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  {selectedFile && selectedFileDiff ? (
                    <FileDiffViewer
                      key={`${selectedFile.subPath}::${selectedFile.path}`}
                      encoded={project.encoded}
                      subPath={selectedFile.subPath}
                      file={selectedFileDiff}
                      annotationsByFile={annotationsByFile}
                      setAnnotationsByFile={setAnnotationsByFile}
                      isStaged={(
                        repoGroups.find(
                          (g) => g.subPath === selectedFile.subPath
                        )?.staged ?? []
                      ).some((s) => s.path === selectedFile.path)}
                      onStage={() =>
                        handleStageFile(
                          selectedFile.path,
                          selectedFile.subPath
                        )
                      }
                      onUnstage={() =>
                        handleUnstageFile(
                          selectedFile.path,
                          selectedFile.subPath
                        )
                      }
                      onDiscard={() =>
                        handleDiscardFile(
                          selectedFile.path,
                          selectedFile.subPath
                        )
                      }
                      onChanged={refreshDiff}
                      confirm={confirm}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                      {repos.length > 0 ? "Select a file" : "Not a git repo"}
                    </div>
                  )}
                </div>
                {aggregatedDiffAnnotations.length > 0 && (
                  <div className="border-t border-[var(--border)] bg-[var(--bg-surface)] p-3">
                    <MessageOutput
                      annotations={aggregatedDiffAnnotations}
                      options={{
                        intro: "Some feedback on the working-tree changes:",
                        leftLabel: "the original",
                        rightLabel: "the changes",
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {tab === "chat" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                  <span className="truncate text-[var(--text-secondary)]">
                    {session?.meta.title ?? selectedSessionId ?? "No session"}
                  </span>
                  <span>
                    {session ? `${session.meta.messageCount} msgs` : ""}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  {session ? (
                    <MessageList
                      messages={session.messages}
                      annotations={chatAnnotations}
                      onAddAnnotation={addChatAnnotation}
                      onUpdateAnnotation={updateChatAnnotation}
                      onRemoveAnnotation={removeChatAnnotation}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                      Select a session
                    </div>
                  )}
                </div>
                {aggregatedChatAnnotations.length > 0 && (
                  <div className="border-t border-[var(--border)] bg-[var(--bg-surface)] p-3">
                    <MessageOutput
                      annotations={aggregatedChatAnnotations}
                      options={{
                        intro: "Some feedback on the conversation:",
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {tab === "plans" && (
              <div className="flex min-h-0 flex-1 flex-col">
                {selectedPlan ? (
                  <PlanViewer key={selectedPlan.filePath} plan={selectedPlan} />
                ) : (
                  <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                    {plans.length === 0
                      ? "Drop a markdown file into ~/.claude/plans/ to see it here."
                      : "Select a plan"}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}

function letterFromCode(code: string): FileEntry["letter"] | null {
  // X is staged-side, Y is unstaged-side. Pick the most informative.
  const codes = [code[0], code[1]].filter((c) => c && c !== " ");
  for (const c of codes) {
    if (c === "A") return "A";
    if (c === "D") return "D";
    if (c === "M") return "M";
    if (c === "R") return "R";
    if (c === "?") return "?";
  }
  return null;
}

function letterFromDiff(diff?: FileDiff): FileEntry["letter"] {
  if (!diff) return "M";
  switch (diff.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function repoDisplayName(repo: DiscoveredRepo, projectCwd: string): string {
  if (!repo.subPath) {
    return projectCwd.split("/").filter(Boolean).pop() ?? projectCwd;
  }
  return repo.subPath;
}
