import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { generateMessage, type Annotation } from "@plan/shared/lib/store";
import { parseUnifiedDiff, type FileDiff } from "@plan/shared/lib/diff-parser";
import { MessageOutput } from "@plan/shared/components/message-output";
import {
  SidebarProvider,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { cn } from "@plan/shared/lib/utils";
import type {
  ProjectEntry,
  ParsedSession,
  GitFileStatus,
  DiscoveredRepo,
} from "../../shared-types";
import { MiddleSidebar, type WorkTab } from "./middle-sidebar";
import { FileDiffViewer } from "./file-diff-viewer";
import { MessageList, type ChatAnnotation } from "./message-list";
import { FileViewer } from "./file-viewer";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { FileIcon } from "./file-icon";
import Fuse from "fuse.js";
import { useConfirm } from "./confirm-dialog";
import { TerminalPanel, type TerminalHandle } from "./terminal-panel";
import { useProjectAnnotations } from "../lib/annotation-store";
import { useProjectTerminals, useTerminalHeight } from "../lib/terminal-store";
import {
  useProjectTabs,
  getProjectTabs,
  openProjectTab,
  closeProjectTab,
  replaceProjectTab,
  makeChatTab,
  makeDiffTab,
  makeFileTab,
  chatTabId,
  type Tab,
} from "../lib/tabs-store";
import { TabBar } from "./tab-bar";
import { useTerminalWorking } from "../lib/terminal-activity-store";
import { ChatInput, type ChatInputHandle } from "./chat-input";
import { RenameSessionDialog } from "./rename-session-dialog";
import { RunConfigModal } from "./run-config-modal";
import { ThemeMenu } from "./theme-menu";
import { SwitcherOverlay } from "./switcher-overlay";
import { useTabSwitcher } from "../lib/use-tab-switcher";
import {
  getMruVersion,
  orderByMru,
  recordUse,
  subscribeMru,
} from "../lib/mru-store";
import { Toaster } from "@plan/shared/components/ui/sonner";
import { mergeSession } from "../lib/merge-session";
import { osNotify, pushToast } from "../lib/toast-store";

/**
 * Sessions created from the UI this run (via `claude --session-id <uuid>`).
 * Their JSONL doesn't exist until the first exchange, so selection and the
 * first terminal spawn need to treat them specially.
 */
const NEW_SESSION_IDS = new Set<string>();

// EXPERIMENTAL input-box/menu detection: when true, fires a toast + devtools log
// on every detected state change so the heuristic's accuracy can be validated.
// Off now that "Needs input" is reliable — flip back on to re-tune the regexes.
const DEBUG_INPUT_DETECT = false;

// Shows a "Copy terminal" button (and ⌘⇧D) in the chat header that copies the
// headless emulator's full rendered text — handy for sharing real Claude Code
// frames to tune the detection heuristics. Flip off to hide it.
const DEBUG_COPY_TERMINAL = false;

import type { SessionListItem } from "./session-list";
import type { FileEntry, RepoFileGroup } from "./file-list";

interface Props {
  project: ProjectEntry;
  repos: DiscoveredRepo[];
  projectsSidebarOpen: boolean;
  /** All projects + a switch callback — drives the ⌘K palette. */
  projects: ProjectEntry[];
  onSelectProject: (encoded: string) => void;
  /** Project-level Run terminal command (shared across this project's worktrees). */
  runCommand?: string;
  /** Optional build command run before the Run command. */
  buildCommand?: string;
  /** Persist the Run/build command to the project (parent-keyed defaults). */
  onSaveRunConfig: (runCommand: string, buildCommand: string) => Promise<void> | void;
}

function WorkspaceHeader({
  project,
  projectsSidebarOpen,
  branch,
}: {
  project: ProjectEntry;
  projectsSidebarOpen: boolean;
  branch: string | null;
}) {
  const middle = useSidebar();
  const shortName = project.cwd.split("/").filter(Boolean).pop() ?? project.cwd;

  return (
    <header
      className={cn(
        "flex h-[44px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] pr-3 pt-2 pb-2 [-webkit-app-region:drag]",
        // Pad past macOS traffic-light area when this header is the leftmost pane.
        projectsSidebarOpen ? "pl-3" : "pl-20",
      )}
    >
      {/* Project name (bold) · path (muted) · branch as a labelled pill. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-3">
        <span className="shrink-0 font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          {shortName}
        </span>
        <span className="hidden min-w-0 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] sm:inline">
          {project.cwd}
        </span>
        {branch && (
          <span className="shrink-0 rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] leading-none text-[var(--text-secondary)]">
            {branch}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <ThemeMenu />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={middle.toggle}
              aria-label="Toggle files & chat sidebar"
            >
              <PanelRightIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-1.5">
            <span>{middle.open ? "Hide" : "Show"} files & chat</span>
            <Kbd keys={["⌘", "E"]} />
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

/** Panel-right glyph — the files/chat (2nd) sidebar toggle. */
function PanelRightIcon() {
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
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

export function ProjectWorkspace({
  project,
  repos,
  projectsSidebarOpen,
  projects,
  onSelectProject,
  runCommand,
  buildCommand,
  onSaveRunConfig,
}: Props) {
  // Headline branch: when a project has multiple repos we just show the first.
  const branch = repos[0]?.branch ?? null;
  // VSCode model: `tab` chooses which LIST shows in the right sidebar. The main
  // content pane is a set of open tabs (chat / diff / file), scoped to this
  // worktree and persisted — see tabs-store. Everything the content pane needs
  // (`openKind` + the per-kind selection) is DERIVED from the active tab below,
  // so the tab list is the single source of truth.
  const [tab, setTab] = useState<WorkTab>("chat");
  const {
    tabs,
    activeId,
    openTab,
    closeTab,
    closeActive,
    setActive,
  } = useProjectTabs(project.encoded);
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );
  const openKind: WorkTab | null =
    activeTab?.kind === "chat"
      ? "chat"
      : activeTab?.kind === "diff"
        ? "diffs"
        : activeTab?.kind === "file"
          ? "files"
          : null;
  const selectedSessionId =
    activeTab?.kind === "chat" ? activeTab.sessionId : null;
  const selectedFile = useMemo(
    () =>
      activeTab?.kind === "diff"
        ? {
            subPath: activeTab.subPath,
            path: activeTab.path,
            staged: activeTab.staged,
          }
        : null,
    [activeTab],
  );
  const selectedProjectFile =
    activeTab?.kind === "file" ? activeTab.path : null;
  // The file currently of interest — the open diff or file. Shared across the
  // Diffs and Files sidebar lists so each highlights it. Project-relative
  // (repo subPath prefixed) to compare across both lists.
  const activeFilePath =
    activeTab?.kind === "file"
      ? activeTab.path
      : activeTab?.kind === "diff"
        ? activeTab.subPath
          ? `${activeTab.subPath}/${activeTab.path}`
          : activeTab.path
        : null;
  const openChatTab = useCallback(
    (sid: string) => openTab(makeChatTab(sid)),
    [openTab],
  );
  const { confirm, dialog: confirmDialog } = useConfirm();

  // ── Files state (per-repo) ───────────────────────────────────
  interface RepoFiles {
    files: FileDiff[];
    status: GitFileStatus[];
    diffAvailable: boolean;
    ahead: number;
    hasUpstream: boolean;
  }
  const [filesByRepo, setFilesByRepo] = useState<Map<string, RepoFiles>>(
    new Map(),
  );
  const [filesLoading, setFilesLoading] = useState(true);
  // True once the first load has populated data. Subsequent refreshes (after a
  // stage/discard/etc.) update in place WITHOUT flipping back to the loading
  // placeholder — that swap unmounts the list and resets its scroll.
  const loadedRef = useRef(false);
  /**
   * The selected diff (`selectedFile`) is derived from the active tab near the
   * top of the component — a diff is identified by repo (subPath), path, and
   * which stage we're viewing (staged vs unstaged), since a partially-staged
   * file appears in both sections and each shows a different diff.
   */
  // Comments persist per-project across first-sidebar switches (the workspace
  // is keyed by `encoded` and remounts on switch). Both the diff annotations
  // (keyed by "subPath::path") and the chat annotations come from this store.
  const {
    annotationsByFile,
    setAnnotationsByFile,
    chatAnnotations,
    setChatAnnotations,
    annotationsByProjectFile,
    setAnnotationsByProjectFile,
  } = useProjectAnnotations(project.encoded);
  /** subPath currently being pushed (for the sync-bar spinner). */
  const [pushingRepo, setPushingRepo] = useState<string | null>(null);

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
              ahead: status.ahead,
              hasUpstream: status.hasUpstream,
            },
          ] as const;
        }),
      );
      const next = new Map(entries);
      setFilesByRepo(next);
      // Reconcile open diff tabs against fresh git status. We DON'T auto-open
      // anything — content only opens on explicit click — but an already-open
      // diff tab must follow its file: close it once the file is no longer
      // changed (committed/discarded), and flip its staged side when the file
      // moves across sections (staging the open diff), so it never goes blank.
      for (const t of getProjectTabs(project.encoded).tabs) {
        if (t.kind !== "diff") continue;
        const status = next
          .get(t.subPath)
          ?.status.find((s) => s.path === t.path);
        if (!status) {
          closeProjectTab(project.encoded, t.id);
          continue;
        }
        if (t.staged ? status.staged : status.unstaged) continue;
        if (t.staged ? status.unstaged : status.staged) {
          replaceProjectTab(
            project.encoded,
            t.id,
            makeDiffTab(t.subPath, t.path, !t.staged),
          );
        } else {
          closeProjectTab(project.encoded, t.id);
        }
      }
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

  // Per-repo push targets for the sync bar (only repos with an upstream or
  // unpushed commits are worth showing).
  const syncTargets = useMemo(
    () =>
      repos
        .map((repo) => {
          const state = filesByRepo.get(repo.subPath);
          return {
            subPath: repo.subPath,
            repoName: repoDisplayName(repo, project.cwd),
            branch: repo.branch,
            ahead: state?.ahead ?? 0,
            hasUpstream: state?.hasUpstream ?? false,
            pushing: pushingRepo === repo.subPath,
          };
        })
        .filter((t) => t.hasUpstream || t.ahead > 0),
    [repos, filesByRepo, project.cwd, pushingRepo],
  );

  // For diff-annotation aggregation (kept global so the copy box at the
  // bottom shows everything regardless of which file is selected).
  const aggregatedDiffAnnotations = useMemo(
    () => Object.values(annotationsByFile).flat(),
    [annotationsByFile],
  );

  // Read-only file-viewer comments across all files — same compose buffer.
  const aggregatedProjectFileAnnotations = useMemo(
    () => Object.values(annotationsByProjectFile).flat(),
    [annotationsByProjectFile],
  );

  // ── Git actions (routed via subPath) ─────────────────────────
  const handleStageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.stageFile(
        project.encoded,
        path,
        subPath,
      );
      if (!res.ok) console.warn("stage failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff],
  );

  const handleUnstageFile = useCallback(
    async (path: string, subPath: string) => {
      const res = await window.electronAPI.unstageFile(
        project.encoded,
        path,
        subPath,
      );
      if (!res.ok) console.warn("unstage failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff],
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
        subPath,
      );
      if (!res.ok) console.warn("discard failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff, confirm],
  );

  const handleStageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.stageAll(project.encoded, subPath);
      if (!res.ok) console.warn("stage all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff],
  );

  const handleUnstageAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.unstageAll(project.encoded, subPath);
      if (!res.ok) console.warn("unstage all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff],
  );

  const handleDiscardAll = useCallback(
    async (subPath: string) => {
      const ok = await confirm({
        title: "Discard all changes?",
        description:
          "This permanently discards every unstaged change and removes untracked files in this repo. It cannot be undone.",
        confirmLabel: "Discard all",
      });
      if (!ok) return;
      const res = await window.electronAPI.discardAll(project.encoded, subPath);
      if (!res.ok) console.warn("discard all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff, confirm],
  );

  const handleStashAll = useCallback(
    async (subPath: string) => {
      const res = await window.electronAPI.stashAll(project.encoded, subPath);
      if (!res.ok) console.warn("stash all failed:", res.error);
      refreshDiff();
    },
    [project.encoded, refreshDiff],
  );

  const handlePush = useCallback(
    async (subPath: string) => {
      setPushingRepo(subPath);
      try {
        const res = await window.electronAPI.push(project.encoded, subPath);
        if (!res.ok) console.warn("push failed:", res.error);
        await refreshDiff();
      } finally {
        setPushingRepo(null);
      }
    },
    [project.encoded, refreshDiff],
  );

  const handleCommit = useCallback(
    async (message: string, subPath: string) => {
      const res = await window.electronAPI.commit(
        project.encoded,
        message,
        subPath,
      );
      if (!res.ok) return { ok: false, error: res.error ?? "Commit failed" };
      refreshDiff();
      return { ok: true };
    },
    [project.encoded, refreshDiff],
  );

  useEffect(() => {
    // Comments and open tabs are intentionally NOT cleared here — they persist
    // per worktree (see useProjectAnnotations / useProjectTabs) so switching
    // projects doesn't lose them.
    refreshDiff();
  }, [refreshDiff]);

  // ── Sessions state ───────────────────────────────────────────
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  // Parsed transcripts for every OPEN chat tab, keyed by session id, so each
  // chat tab keeps a live, mounted MessageList (its scroll survives switching
  // tabs). The watcher refreshes whichever open transcripts change. The active
  // chat tab's transcript is exposed as `session` for the status/notify logic.
  const [transcripts, setTranscripts] = useState<Map<string, ParsedSession>>(
    new Map(),
  );
  const session = useMemo(
    () => (selectedSessionId ? (transcripts.get(selectedSessionId) ?? null) : null),
    [transcripts, selectedSessionId],
  );
  // Composer handle (⌘L focuses it; "Add to chat" appends to it). The text
  // itself lives inside ChatInput so keystrokes don't re-render the workspace.
  const chatInputRef = useRef<ChatInputHandle>(null);

  // Session ids that currently have an open chat tab — drives transcript loads.
  const chatSessionIds = useMemo(
    () => tabs.filter((t) => t.kind === "chat").map((t) => t.sessionId),
    [tabs],
  );
  // Ref mirror so the (rarely re-subscribed) watcher can see the current set
  // without re-subscribing every time a tab opens/closes.
  const chatSessionIdsRef = useRef(chatSessionIds);
  chatSessionIdsRef.current = chatSessionIds;

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      // List metadata comes straight from main's mtime cache — never fetch
      // full transcripts here (that froze the renderer on every watcher tick).
      const list = await window.electronAPI.listSessions(project.encoded);
      // Newest first by the transcript's own timestamp (mtime is a fallback —
      // it moves on any file touch, e.g. a resume, not just new messages).
      const toMillis = (
        v: number | string | null,
        fallback: number,
      ): number => {
        if (v == null) return fallback;
        if (typeof v === "number") return v;
        const t = new Date(v).getTime();
        return Number.isNaN(t) ? fallback : t;
      };
      const enriched: SessionListItem[] = [...list]
        .sort(
          (a, b) =>
            toMillis(b.updatedAt, b.mtimeMs) - toMillis(a.updatedAt, a.mtimeMs),
        )
        .map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          archived: s.archived,
        }));
      setSessions(enriched);
      // No auto-select: the content pane only shows what you've opened as a
      // tab. A fresh worktree opens to an empty pane (click a chat to open it).
    } finally {
      setSessionsLoading(false);
    }
  }, [project.encoded]);

  const handleSetSessionArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      await window.electronAPI.setSessionArchived(sessionId, archived);
      // Archiving puts a chat away, so free its resources: kill the connected
      // `claude` pty if one exists (a no-op otherwise). The terminal:exit event
      // then drops it from openedIds. No hidden Claude left running for it.
      if (archived) {
        window.electronAPI.terminalKill(`chat:${project.encoded}:${sessionId}`);
      }
      refreshSessions();
    },
    [refreshSessions, project.encoded],
  );

  // ⌘⇧A: toggle archive on the open chat immediately (no dialog). Archiving
  // shows a short-lived "Unarchive" toast so an accidental archive can be
  // reversed; pressing it again on an already-archived chat unarchives it.
  const handleToggleArchiveCurrentChat = useCallback(() => {
    if (openKind !== "chat" || !selectedSessionId) return;
    const sid = selectedSessionId;
    const current = sessions.find((s) => s.sessionId === sid);
    if (!current) return;

    // If the open chat is already archived, unarchive it and keep it open.
    if (current.archived) {
      void handleSetSessionArchived(sid, false);
      openChatTab(sid);
      return;
    }

    const title = current.title ?? "Untitled chat";
    // Archiving puts the chat away — close its tab (closeTab lands focus on a
    // neighbouring tab on its own). Undo reopens it.
    void handleSetSessionArchived(sid, true);
    closeTab(chatTabId(sid));

    pushToast(
      {
        text: `“${title}” archived. Undo to bring it back.`,
        actionLabel: "Unarchive",
        onAction: () => {
          void handleSetSessionArchived(sid, false);
          // Undo restores the archived chat to the content pane.
          openChatTab(sid);
        },
      },
      6000,
    );
  }, [
    openKind,
    selectedSessionId,
    sessions,
    handleSetSessionArchived,
    openChatTab,
    closeTab,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "a"
      ) {
        if (openKind !== "chat" || !selectedSessionId) return;
        e.preventDefault();
        handleToggleArchiveCurrentChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleToggleArchiveCurrentChat, openKind, selectedSessionId]);

  const refreshTranscript = useCallback(
    async (sid: string) => {
      const parsed = await window.electronAPI.readSession(project.encoded, sid);
      // Identity-preserving merge: unchanged messages keep their old objects so
      // memoized rows skip re-rendering (otherwise every watcher tick re-renders
      // the whole transcript's markdown).
      setTranscripts((prev) => {
        const merged = mergeSession(prev.get(sid) ?? null, parsed);
        // null = no transcript yet (e.g. a brand-new chat before its first
        // exchange) — leave it unset so the pane shows the "new chat" hint.
        if (!merged) return prev;
        const next = new Map(prev);
        next.set(sid, merged);
        return next;
      });
    },
    [project.encoded],
  );

  useEffect(() => {
    // The workspace remounts per project (keyed by encoded), so initial state
    // is already fresh — don't clear the persisted session/annotations here.
    refreshSessions();
  }, [refreshSessions]);

  // Load a transcript for every open chat tab (and drop ones whose tab closed)
  // so each chat tab's MessageList stays mounted with live content.
  useEffect(() => {
    for (const sid of chatSessionIds) void refreshTranscript(sid);
    setTranscripts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const sid of prev.keys()) {
        if (!chatSessionIds.includes(sid)) {
          next.delete(sid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [chatSessionIds, refreshTranscript]);

  // Watcher: re-pull what's relevant. Debounced — a streaming session fires
  // events continuously, and refreshing (git + session list + transcript) on
  // every single one stalls the renderer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wantSelected = false;
    const changedSids = new Set<string>();
    const off = window.electronAPI.onWatcherEvent((e) => {
      if (e.encoded !== project.encoded) return;
      // Refresh the transcript of any OPEN chat tab whose JSONL changed.
      if (e.sessionId && chatSessionIdsRef.current.includes(e.sessionId)) {
        wantSelected = true;
        changedSids.add(e.sessionId);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshDiff();
        refreshSessions();
        if (wantSelected) {
          wantSelected = false;
          for (const sid of changedSids) void refreshTranscript(sid);
          changedSids.clear();
        }
      }, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [project.encoded, refreshDiff, refreshSessions, refreshTranscript]);

  // ── Project files (Files tab + ⌘P) ───────────────────────────
  // Indexed lazily the first time the Files tab (or ⌘P) is used, then cached
  // for this project mount. The list is also the source for the ⌘P finder.
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  // Ref (not state) so a failed attempt doesn't permanently lock indexing and
  // the callback identity stays stable (no effect loop).
  const filesRequestedRef = useRef(false);
  // `selectedProjectFile` is derived from the active tab near the top.
  // A pending "jump to this match" for the file viewer (from the Search tab).
  // `nonce` re-triggers the scroll even when the same line is clicked twice.
  const [fileReveal, setFileReveal] = useState<{
    path: string;
    line: number;
    colStart: number;
    colEnd: number;
    nonce: number;
  } | null>(null);

  const indexProjectFiles = useCallback(async () => {
    if (filesRequestedRef.current) return;
    filesRequestedRef.current = true;
    setProjectFilesLoading(true);
    try {
      const fn = window.electronAPI.listProjectFiles;
      if (typeof fn !== "function") {
        // Stale preload build — the IPC method isn't exposed yet.
        console.error(
          "[files] window.electronAPI.listProjectFiles is missing — main/preload build is stale; relaunch.",
        );
        filesRequestedRef.current = false;
        return;
      }
      const list = await fn(project.encoded);
      setProjectFiles(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error("[files] index failed:", e);
      filesRequestedRef.current = false; // allow a retry
    } finally {
      setProjectFilesLoading(false);
    }
  }, [project.encoded]);

  useEffect(() => {
    if (tab === "files") void indexProjectFiles();
  }, [tab, indexProjectFiles]);

  const handleSelectProjectFile = useCallback(
    (path: string) => openTab(makeFileTab(path)),
    [openTab],
  );

  // A Search-tab hit: open the file in a tab and scroll/highlight the match.
  // Keeps the sidebar on the Search tab (VS Code behaviour) — only the content
  // pane changes.
  const handleOpenSearchResult = useCallback(
    (path: string, line: number, colStart: number, colEnd: number) => {
      openTab(makeFileTab(path));
      setFileReveal((prev) => ({
        path,
        line,
        colStart,
        colEnd,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    },
    [openTab],
  );

  // Clicking a chat in the list opens its conversation in a tab.
  const handleSelectSession = useCallback(
    (id: string) => openChatTab(id),
    [openChatTab],
  );

  // ── Command palette: ⌘P (files) / ⌘K (switch project or chat) ──────────
  const [paletteMode, setPaletteMode] = useState<"files" | "switch" | null>(
    null,
  );
  const [paletteQuery, setPaletteQuery] = useState("");
  const closePalette = useCallback(() => {
    setPaletteMode(null);
    setPaletteQuery("");
  }, []);

  // ⌘P: fuzzy file finder (Fuse over the project file index, capped for speed).
  const fileFuse = useMemo(
    () => new Fuse(projectFiles, { threshold: 0.4, ignoreLocation: true }),
    [projectFiles],
  );
  const fileItems = useMemo<PaletteItem[]>(() => {
    if (paletteMode !== "files") return [];
    const q = paletteQuery.trim();
    const matched = q
      ? fileFuse.search(q, { limit: 200 }).map((r) => r.item)
      : projectFiles.slice(0, 200);
    return matched.map((f) => ({
      id: f,
      label: fileBase(f),
      sublabel: fileDir(f),
      icon: <FileIcon name={fileBase(f)} />,
      onSelect: () => {
        // openKind (not tab) drives the content pane — set both so the file
        // actually opens instead of just highlighting in the sidebar.
        handleSelectProjectFile(f);
        setTab("files");
        closePalette();
      },
    }));
  }, [
    paletteMode,
    paletteQuery,
    fileFuse,
    projectFiles,
    handleSelectProjectFile,
    closePalette,
  ]);

  // ⌘K: switch across every project AND their chats (each chat tagged with the
  // project it belongs to). Chats are pulled from all projects on open.
  const [allChats, setAllChats] = useState<
    {
      sessionId: string;
      title: string;
      projectEncoded: string;
      projectName: string;
    }[]
  >([]);
  const loadAllChats = useCallback(async () => {
    const active = projects.filter((p) => !p.archived);
    const lists = await Promise.all(
      active.map(async (p) => {
        try {
          const list = await window.electronAPI.listSessions(p.encoded);
          return list
            .filter((s) => !s.archived)
            .map((s) => ({
              sessionId: s.sessionId,
              title: s.title ?? "Untitled chat",
              projectEncoded: p.encoded,
              projectName: projShortName(p),
            }));
        } catch {
          return [];
        }
      }),
    );
    setAllChats(lists.flat());
  }, [projects]);

  const switchEntries = useMemo<SwitchEntry[]>(() => {
    const projEntries: SwitchEntry[] = projects
      .filter((p) => !p.archived)
      .map((p) => ({
        id: `p:${p.encoded}`,
        name: projShortName(p),
        project: p.cwd,
        badge: "project",
        run: () => onSelectProject(p.encoded),
      }));
    const chatEntries: SwitchEntry[] = allChats.map((c) => ({
      id: `s:${c.projectEncoded}:${c.sessionId}`,
      name: c.title,
      project: c.projectName,
      badge: "chat",
      run: () => {
        if (c.projectEncoded === project.encoded) {
          openChatTab(c.sessionId);
          setTab("chat");
        } else {
          // Cross-worktree: open the chat tab in the target's persisted tab set
          // (read on mount), then switch worktrees.
          openProjectTab(c.projectEncoded, makeChatTab(c.sessionId));
          onSelectProject(c.projectEncoded);
        }
      },
    }));
    return [...projEntries, ...chatEntries];
  }, [projects, allChats, project.encoded, onSelectProject, openChatTab]);

  const switchFuse = useMemo(
    () =>
      new Fuse(switchEntries, {
        keys: ["name", "project"],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [switchEntries],
  );
  const switchItems = useMemo<PaletteItem[]>(() => {
    if (paletteMode !== "switch") return [];
    const q = paletteQuery.trim();
    const matched = q
      ? switchFuse.search(q, { limit: 100 }).map((r) => r.item)
      : switchEntries.slice(0, 100);
    return matched.map((e) => ({
      id: e.id,
      label: e.name,
      sublabel: e.project,
      badge: e.badge,
      onSelect: () => {
        e.run();
        closePalette();
      },
    }));
  }, [paletteMode, paletteQuery, switchFuse, switchEntries, closePalette]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        void indexProjectFiles();
        setPaletteQuery("");
        setPaletteMode("files");
      } else if (k === "k") {
        // ⌘K inside a terminal clears that terminal (xterm handles it) — don't
        // also pop the command palette.
        if (isTerminalFocused()) return;
        e.preventDefault();
        void loadAllChats();
        setPaletteQuery("");
        setPaletteMode("switch");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [indexProjectFiles, loadAllChats]);

  // ── Project-file (read-only viewer) annotation handlers ──────
  // Parameterized by `path` because several file tabs can be open at once; each
  // FileViewer binds these to its own path.
  const addProjectFileAnnotation = useCallback(
    (
      path: string,
      selectedText: string,
      startOffset: number,
      endOffset: number,
      startLine: number,
      endLine: number,
      comment: string,
    ) => {
      setAnnotationsByProjectFile((prev) => ({
        ...prev,
        [path]: [
          ...(prev[path] ?? []),
          {
            id: crypto.randomUUID(),
            selectedText,
            startOffset,
            endOffset,
            comment,
            side: "right",
            context: { filePath: path, startLine, endLine },
          },
        ],
      }));
    },
    [setAnnotationsByProjectFile],
  );
  const updateProjectFileAnnotation = useCallback(
    (path: string, id: string, comment: string) => {
      setAnnotationsByProjectFile((prev) => ({
        ...prev,
        [path]: (prev[path] ?? []).map((a) =>
          a.id === id ? { ...a, comment } : a,
        ),
      }));
    },
    [setAnnotationsByProjectFile],
  );
  const removeProjectFileAnnotation = useCallback(
    (path: string, id: string) => {
      setAnnotationsByProjectFile((prev) => ({
        ...prev,
        [path]: (prev[path] ?? []).filter((a) => a.id !== id),
      }));
    },
    [setAnnotationsByProjectFile],
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
    [chatAnnotations],
  );

  // One outgoing buffer combining code-diff annotations and chat annotations,
  // so a single compose box can Copy / Send-to-terminal everything at once.
  const totalComments =
    aggregatedDiffAnnotations.length +
    aggregatedChatAnnotations.length +
    aggregatedProjectFileAnnotations.length;
  const composedMessage = useMemo(() => {
    const parts: string[] = [];
    if (aggregatedProjectFileAnnotations.length > 0) {
      parts.push(
        "On the files:\n\n" +
          generateMessage(aggregatedProjectFileAnnotations, { intro: "" }),
      );
    }
    if (aggregatedDiffAnnotations.length > 0) {
      parts.push(
        "On the code changes:\n\n" +
          generateMessage(aggregatedDiffAnnotations, {
            intro: "",
            leftLabel: "the original",
            rightLabel: "the changes",
          }),
      );
    }
    if (aggregatedChatAnnotations.length > 0) {
      parts.push(
        "On the conversation:\n\n" +
          generateMessage(aggregatedChatAnnotations, { intro: "" }),
      );
    }
    return parts.join("\n\n");
  }, [
    aggregatedDiffAnnotations,
    aggregatedChatAnnotations,
    aggregatedProjectFileAnnotations,
  ]);

  // ── Chat annotation handlers ─────────────────────────────────
  const addChatAnnotation = useCallback(
    (
      messageUuid: string,
      partIndex: number,
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string,
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
    [],
  );
  const updateChatAnnotation = useCallback((id: string, comment: string) => {
    setChatAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, comment } : a)),
    );
  }, []);
  const removeChatAnnotation = useCallback((id: string) => {
    setChatAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /**
   * The FileDiff for the currently-selected file. Untracked files (and any
   * status entry that `git diff HEAD` doesn't emit) get a synthetic FileDiff
   * so they still open in the viewer — FileDiffViewer fetches the actual
   * content itself via getFileContents.
   */
  // Resolve a diff for any (subPath, path) — used per diff tab in the render.
  const getFileDiff = useCallback(
    (subPath: string, path: string): FileDiff | null => {
      const repo = filesByRepo.get(subPath);
      if (!repo) return null;
      const fromDiff = repo.files.find((f) => f.path === path);
      if (fromDiff) return fromDiff;

      // Not in the diff — synthesize from the status entry.
      const status = repo.status.find((s) => s.path === path);
      if (!status) return null;
      const isDeleted = status.code.includes("D");
      const isUntracked = status.code === "??";
      const statusKind: FileDiff["status"] = isDeleted
        ? "deleted"
        : isUntracked
          ? "added"
          : "modified";
      return {
        path,
        oldPath: isUntracked ? null : path,
        newPath: isDeleted ? null : path,
        status: statusKind,
        body: "",
        additions: 0,
        deletions: 0,
        binary: false,
      };
    },
    [filesByRepo],
  );

  const handleSelectFile = useCallback(
    (subPath: string, path: string, staged: boolean) => {
      openTab(makeDiffTab(subPath, path, staged));
    },
    [openTab],
  );

  // A tab's display title — derived from live data so a renamed chat / moved
  // file stays current (titles are never stored on the tab itself).
  const titleForTab = useCallback(
    (t: Tab): string => {
      if (t.kind === "chat") {
        return (
          sessions.find((s) => s.sessionId === t.sessionId)?.title ??
          transcripts.get(t.sessionId)?.meta.title ??
          (NEW_SESSION_IDS.has(t.sessionId) ? "New chat" : "Chat")
        );
      }
      return t.path.split("/").pop() || t.path;
    },
    [sessions, transcripts],
  );

  // ── Terminals (⌘J) ───────────────────────────────────────────
  // Each project has a default terminal; each chat the user "resumes" gets its
  // own terminal running `claude --resume <id>`; the sidebar's Terminals
  // section adds scratch shells. All opened terminals stay mounted (hidden) so
  // scrollback survives switching between them. Terminal view-state persists
  // per project across first-sidebar switches.
  const {
    openedIds,
    setOpenedIds,
    terminalOpen,
    setTerminalOpen,
    shells,
    setShells,
    activeShellId,
    setActiveShellId,
  } = useProjectTerminals(project.encoded);
  // Dock height is a single global, persisted value — shared across projects.
  const [terminalHeight, setTerminalHeight] = useTerminalHeight();
  // The dock is mounted whenever there's at least one opened terminal.
  const terminalMounted = openedIds.length > 0;

  const chatPrefix = `chat:${project.encoded}:`;
  const shellPrefix = `term:${project.encoded}:`;
  const sessionTermId = (sid: string) => `${chatPrefix}${sid}`;
  const initialCommandFor = (tid: string): string | undefined => {
    if (!tid.startsWith(chatPrefix)) return undefined;
    const sid = tid.slice(chatPrefix.length);
    // Brand-new chats start claude with a pre-chosen session id (nothing to
    // resume yet); existing ones resume their transcript.
    return NEW_SESSION_IDS.has(sid)
      ? `claude --session-id ${sid}`
      : `claude --resume ${sid}`;
  };

  // The dock (⌘J) mirrors the selected chat's Claude instance — on the Diffs
  // and Files tabs too, not just the Chat tab — so ⌘J anywhere brings up the
  // same running agent. The dock is NEVER a plain shell: with no live chat
  // terminal there's nothing to show, so it stays closed (see the ⌘J handler
  // and the exit handler). Scratch shells live in the sidebar's Terminals
  // section instead.
  const sessionResumed =
    selectedSessionId != null &&
    openedIds.includes(sessionTermId(selectedSessionId));
  const activeTerminalId = sessionResumed
    ? sessionTermId(selectedSessionId!)
    : null;
  const activeTerminalIdRef = useRef(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;

  // Imperative handles + readiness, keyed by terminal id (for sending to a pty).
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());
  const readyIds = useRef<Set<string>>(new Set());
  const pendingPasteRef = useRef<{
    id: string;
    text: string;
    imagePaths: string[];
    submit: boolean;
  } | null>(null);

  const ensureOpened = useCallback((tid: string) => {
    setOpenedIds((ids) => (ids.includes(tid) ? ids : [...ids, tid]));
  }, []);

  const writeToTerminal = (
    tid: string,
    text: string,
    imagePaths: string[],
    submit: boolean,
  ) => {
    if (submit) {
      // Main pastes the body, types any image paths (so Claude attaches them),
      // then sends Enter as a SEPARATE keystroke a beat later — Claude's TUI
      // ignores an Enter bundled with the paste itself.
      window.electronAPI.terminalSubmit(tid, text, imagePaths);
    } else {
      const body = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
      window.electronAPI.terminalInput(tid, `\x1b[200~${body}\x1b[201~`);
    }
  };

  const handleTerminalReady = useCallback((tid: string) => {
    readyIds.current.add(tid);
    const p = pendingPasteRef.current;
    if (p && p.id === tid) {
      writeToTerminal(p.id, p.text, p.imagePaths, p.submit);
      pendingPasteRef.current = null;
    }
  }, []);

  // Send text (+ optional image paths) to terminal `tid`, queuing until ready.
  const sendToTerminal = useCallback(
    (tid: string, text: string, imagePaths: string[], submit: boolean) => {
      if (!text.trim() && imagePaths.length === 0) return;
      ensureOpened(tid);
      if (readyIds.current.has(tid))
        writeToTerminal(tid, text, imagePaths, submit);
      else pendingPasteRef.current = { id: tid, text, imagePaths, submit };
    },
    [ensureOpened],
  );

  // Whether the selected chat has a live (resumed) terminal to send into.
  const chatTerminalReady =
    selectedSessionId != null &&
    openedIds.includes(`${chatPrefix}${selectedSessionId}`);

  // session in a ref so callbacks can read the latest without re-creating.
  const sessionRef = useRef<ParsedSession | null>(null);
  sessionRef.current = session;

  // Send watchdog: if no user message lands in the transcript within 12s of a
  // UI send, the message may be stuck behind a TUI prompt — say so.
  const sendWatchdogRef = useRef<{
    baseLen: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // Reveal a chat's terminal: select the chat, switch to its tab, snap the
  // dock off any scratch shell, and open it — so the dock lands on THAT chat's
  // terminal regardless of where the user currently is.
  const revealChatTerminal = useCallback(
    (sid: string) => {
      openChatTab(sid);
      setTab("chat");
      setActiveShellId(null);
      setTerminalOpen(true);
    },
    [openChatTab, setActiveShellId, setTerminalOpen],
  );

  const armSendWatchdog = useCallback(
    (sid: string) => {
      if (sendWatchdogRef.current) clearTimeout(sendWatchdogRef.current.timer);
      sendWatchdogRef.current = {
        baseLen: sessionRef.current?.messages.length ?? 0,
        timer: setTimeout(() => {
          sendWatchdogRef.current = null;
          pushToast({
            text: "Your message hasn't appeared in the session log after 12s — Claude may be stuck on a prompt. Check the terminal.",
            actionLabel: "Open terminal",
            onAction: () => revealChatTerminal(sid),
          });
          if (!document.hasFocus())
            osNotify("plan", "Message may be stuck — check the terminal");
        }, 12_000),
      };
    },
    [revealChatTerminal],
  );

  // Chat composer: send a message into the selected chat's `claude` (submits).
  // No optimistic echo / "working" indicator — the transcript (JSONL watcher)
  // is the source of truth; the message appears when it actually lands.
  const handleSendChat = useCallback(
    (text: string, imagePaths: string[] = []) => {
      if (!selectedSessionId) return;
      const tid = `${chatPrefix}${selectedSessionId}`;
      if (!openedIds.includes(tid)) return;
      sendToTerminal(tid, text, imagePaths, true);
      // The transcript will confirm delivery; if it doesn't within 12s, the
      // watchdog says so (toast + notification) instead of leaving you lost.
      armSendWatchdog(selectedSessionId);
    },
    [selectedSessionId, chatPrefix, openedIds, sendToTerminal, armSendWatchdog],
  );

  // Drive the chat terminal's TUI selectors (e.g. AskUserQuestion options)
  // with discrete keystrokes.
  const handleSendKeysToChat = useCallback(
    (keys: string[]) => {
      if (!selectedSessionId) return;
      const tid = `${chatPrefix}${selectedSessionId}`;
      if (!openedIds.includes(tid)) return;
      window.electronAPI.terminalSendKeys(tid, keys);
    },
    [selectedSessionId, chatPrefix, openedIds],
  );

  // New chat: pre-pick the session uuid and start `claude --session-id` in a
  // background terminal — the composer is immediately live; the transcript
  // appears with the first exchange.
  const handleNewChat = useCallback(() => {
    const sid = crypto.randomUUID();
    NEW_SESSION_IDS.add(sid);
    openChatTab(sid);
    ensureOpened(`${chatPrefix}${sid}`);
    setTab("chat");
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [chatPrefix, ensureOpened, openChatTab]);

  // ── Activity signals (all transcript/OS facts — nothing invented) ──

  // The transcript is the truth: a user message arriving clears the watchdog.
  useEffect(() => {
    const w = sendWatchdogRef.current;
    if (!w || !session) return;
    const delivered = session.messages
      .slice(w.baseLen)
      .some(
        (m) =>
          m.role === "user" && m.parts.some((p) => p.kind !== "tool_result"),
      );
    if (delivered) {
      clearTimeout(w.timer);
      sendWatchdogRef.current = null;
    }
  }, [session]);
  useEffect(() => {
    // Watchdog is per-session.
    if (sendWatchdogRef.current) {
      clearTimeout(sendWatchdogRef.current.timer);
      sendWatchdogRef.current = null;
    }
  }, [selectedSessionId]);

  // Reply notification: a NEW assistant message in the transcript (fact).
  // OS notification + sound when the app is unfocused; toast when you're on
  // another tab. Nothing while you're already watching the chat.
  const lastAssistantUuidRef = useRef<string | null>(null);
  const notifyBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const lastAssistant = [...session.messages]
      .reverse()
      .find(
        (m) => m.role === "assistant" && m.parts.some((p) => p.kind === "text"),
      );
    const uuid = lastAssistant?.uuid ?? null;
    if (notifyBaselineRef.current !== selectedSessionId) {
      // First load of this session — baseline, don't notify about history.
      notifyBaselineRef.current = selectedSessionId;
      lastAssistantUuidRef.current = uuid;
      return;
    }
    if (uuid && uuid !== lastAssistantUuidRef.current) {
      lastAssistantUuidRef.current = uuid;
      const title =
        sessions.find((s) => s.sessionId === selectedSessionId)?.title ??
        "Claude";
      if (!document.hasFocus()) {
        osNotify("Claude replied", title);
      } else if (tab !== "chat") {
        pushToast({
          text: `Claude replied in “${title}”`,
          actionLabel: "View",
          onAction: () => setTab("chat"),
        });
      }
    }
  }, [session, selectedSessionId, sessions, tab]);

  // Stall signal: the transcript's LAST message has a tool call with no result
  // and nothing new has been written for 20s — that's the shape of a pending
  // permission prompt. Worded as "may", because that's all we can know.
  useEffect(() => {
    if (!session || !chatTerminalReady || !selectedSessionId) return;
    const sid = selectedSessionId;
    const last = session.messages[session.messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const resultIds = new Set<string>();
    for (const m of session.messages)
      for (const p of m.parts)
        if (p.kind === "tool_result") resultIds.add(p.toolUseId);
    const pendingTool = last.parts.some(
      (p) => p.kind === "tool_use" && !resultIds.has(p.id),
    );
    if (!pendingTool) return;
    const timer = setTimeout(() => {
      pushToast(
        {
          text: "Claude may be waiting on a tool approval — check the terminal.",
          actionLabel: "Open terminal",
          onAction: () => revealChatTerminal(sid),
        },
        15_000,
      );
      if (!document.hasFocus())
        osNotify("plan", "Claude may be waiting on an approval");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [session, chatTerminalReady, selectedSessionId, revealChatTerminal]);

  // Agent status: poll the pty's foreground process name (an OS fact) so the
  // header can say whether Claude itself is running in the chat terminal.
  const [agentProcess, setAgentProcess] = useState<string | null>(null);
  useEffect(() => {
    if (!chatTerminalReady || !selectedSessionId) {
      setAgentProcess(null);
      return;
    }
    const tid = `${chatPrefix}${selectedSessionId}`;
    let alive = true;
    const poll = async () => {
      try {
        const st = await window.electronAPI.terminalStatus(tid);
        if (alive) setAgentProcess(st.running ? st.process : null);
      } catch {
        // Status unavailable — show the neutral state, not a wrong one.
        if (alive) setAgentProcess(null);
      }
    };
    void poll();
    const interval = setInterval(poll, 5_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [chatTerminalReady, selectedSessionId, chatPrefix]);
  // Claude's CLI runs under node; either name means the agent process is live.
  const agentLive = /claude|node/i.test(agentProcess ?? "");
  // Live "is Claude actively emitting output right now" — an observed fact from
  // the pty stream, not a guess. The spinner redraws while it works, so output
  // flowing = working; output stopped = idle (done or blocked on approval).
  const chatWorking = useTerminalWorking(
    selectedSessionId ? `${chatPrefix}${selectedSessionId}` : null,
  );

  // ── EXPERIMENTAL: input-box vs. selection-menu detection ─────────────
  // Heuristic read of the chat terminal's rendered screen (a headless emulator
  // in main scans the bottom rows for Claude's TUI box). "selection" means a
  // numbered approval/plan/question menu is up — there's NO free-text box, so
  // sending a message + Enter would mis-navigate the menu. This is a guess, not
  // a protocol; DEBUG_INPUT_DETECT (module scope) toasts accuracy for tuning.
  const [inputState, setInputState] = useState<
    "input" | "selection" | "unknown"
  >("unknown");
  const lastDetectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatTerminalReady || !selectedSessionId) {
      setInputState("unknown");
      lastDetectRef.current = null;
      return;
    }
    const tid = `${chatPrefix}${selectedSessionId}`;
    let alive = true;
    const poll = async () => {
      try {
        const res = await window.electronAPI.terminalInputState(tid);
        if (!alive) return;
        setInputState(res.state);
        if (DEBUG_INPUT_DETECT && res.state !== lastDetectRef.current) {
          lastDetectRef.current = res.state;
          // Full grid tail to devtools (toasts truncate) so the glyphs that
          // drove the classification can be inspected and the regexes tuned.
          console.debug(`[input-detect] ${res.state}\n` + res.lines.join("\n"));
          pushToast(
            {
              text: `[detect] ${res.state} — ${
                res.lines.slice(-3).join(" ⏎ ") || "(empty)"
              }`,
            },
            6_000,
          );
        }
      } catch {
        if (alive) setInputState("unknown");
      }
    };
    void poll();
    const interval = setInterval(poll, 1_500);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [chatTerminalReady, selectedSessionId, chatPrefix]);

  // A rendered selection menu IS the "waiting for you" signal — it must win
  // over the output-recency "working" heuristic, NOT be gated by it: Claude
  // keeps repainting the prompt (cursor blink / box redraw) while it waits, so
  // `chatWorking` stays true the whole time the menu is up. We only require the
  // agent process to be live (a stray menu in a dead shell isn't actionable).
  const awaitingSelection = agentLive && inputState === "selection";

  // Auto-reveal the terminal when a menu appears so the user can respond —
  // only once per transition into the selection state (not on every poll).
  const autoRevealedRef = useRef(false);
  useEffect(() => {
    if (awaitingSelection && !autoRevealedRef.current) {
      autoRevealedRef.current = true;
      revealChatTerminal(selectedSessionId!);
      pushToast({
        text: "Claude may be waiting on a menu selection — respond in the terminal.",
        actionLabel: "Open terminal",
        onAction: () => revealChatTerminal(selectedSessionId!),
      });
    } else if (!awaitingSelection) {
      autoRevealedRef.current = false;
    }
  }, [awaitingSelection, selectedSessionId, revealChatTerminal]);

  // Debug: copy the chat terminal's full rendered text to the clipboard so it
  // can be shared to tune the detection heuristics (button + ⌘⇧D).
  const copyTerminalDump = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const text = await window.electronAPI.terminalDump(
        `${chatPrefix}${selectedSessionId}`,
      );
      await navigator.clipboard.writeText(text);
      pushToast({ text: `Copied terminal (${text.length} chars)` }, 3_000);
    } catch {
      pushToast({ text: "Couldn't copy the terminal" }, 3_000);
    }
  }, [selectedSessionId, chatPrefix]);

  useEffect(() => {
    if (!DEBUG_COPY_TERMINAL) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "d"
      ) {
        e.preventDefault();
        void copyTerminalDump();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [copyTerminalDump]);

  // Conversation turns (user messages that aren't tool results) — far more
  // meaningful than raw transcript entry count, and free to compute.
  const turnCount = useMemo(
    () =>
      session
        ? session.messages.filter(
            (m) =>
              m.role === "user" &&
              m.parts.some((p) => p.kind !== "tool_result"),
          ).length
        : 0,
    [session],
  );

  // "Add to chat": move the composed comments into the chat composer, then
  // clear them — they now live in the composer text.
  const handleAddToChat = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setTab("chat");
      // Land on a chat tab so the composer exists to receive the text: keep the
      // active chat, else focus the most recent open chat tab, else start one.
      if (activeTab?.kind !== "chat") {
        const lastChat = [...tabs].reverse().find((t) => t.kind === "chat");
        if (lastChat) setActive(lastChat.id);
        else handleNewChat();
      }
      setAnnotationsByFile({});
      setChatAnnotations([]);
      setAnnotationsByProjectFile({});
      requestAnimationFrame(() => {
        chatInputRef.current?.append(text);
        chatInputRef.current?.focus();
      });
    },
    [
      activeTab,
      tabs,
      setActive,
      handleNewChat,
      setAnnotationsByFile,
      setChatAnnotations,
      setAnnotationsByProjectFile,
    ],
  );

  // "Clear" the comment buffer — discards every comment across files, diffs,
  // and chat. Gated behind a confirmation since it can't be undone.
  const handleClearComments = useCallback(async () => {
    const ok = await confirm({
      title: "Clear all comments?",
      description:
        "This permanently removes every comment you've added across files, diffs, and the chat. This can't be undone.",
      confirmLabel: "Clear comments",
    });
    if (!ok) return;
    setAnnotationsByFile({});
    setChatAnnotations([]);
    setAnnotationsByProjectFile({});
  }, [
    confirm,
    setAnnotationsByFile,
    setChatAnnotations,
    setAnnotationsByProjectFile,
  ]);

  // "Run terminal": start `claude --resume` for the selected session in the
  // background (does NOT reveal the dock). Enables the composer.
  const handleResumeChat = useCallback(() => {
    if (!selectedSessionId) return;
    ensureOpened(`${chatPrefix}${selectedSessionId}`);
  }, [selectedSessionId, chatPrefix, ensureOpened]);

  // ⌘J's connect path: hook the selected chat up to Claude if it isn't already
  // (runs `claude --resume` in the background) AND reveal the dock — one action,
  // no separate "Connect" step.
  const connectAndShowChat = useCallback(() => {
    if (selectedSessionId) ensureOpened(`${chatPrefix}${selectedSessionId}`);
    setTerminalOpen(true);
  }, [selectedSessionId, chatPrefix, ensureOpened, setTerminalOpen]);

  // ── Scratch shells (sidebar "Terminals" section) ─────────────
  const shellNumber = useCallback(
    (id: string) => parseInt(id.slice(shellPrefix.length), 10) || 0,
    [shellPrefix],
  );

  const [runConfigOpen, setRunConfigOpen] = useState(false);

  // The Run terminal is always first and non-closable; its pty id is scoped to
  // this worktree's encoded so the running process is per-worktree (the command
  // itself is project-level, threaded in via props).
  const sidebarTerminals = useMemo(
    () => [
      { id: `run:${project.encoded}`, label: "Run", kind: "run" as const },
      ...shells.map((id) => ({
        id,
        label: `Terminal ${shellNumber(id)}`,
        kind: "shell" as const,
      })),
    ],
    [project.encoded, shells, shellNumber],
  );

  const handleNewShell = useCallback(() => {
    // Numbering reuses gaps after closes; the pty behind a reused id is fresh.
    const n = shells.reduce((m, id) => Math.max(m, shellNumber(id)), 0) + 1;
    const id = `${shellPrefix}${n}`;
    setShells((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveShellId(id);
  }, [shells, shellNumber, shellPrefix, setShells, setActiveShellId]);

  const handleSelectShell = useCallback(
    (id: string) => {
      setActiveShellId(id);
    },
    [setActiveShellId],
  );

  const removeShell = useCallback(
    (id: string) => {
      readyIds.current.delete(id);
      const remaining = shells.filter((x) => x !== id);
      setShells(remaining);
      // Closing the shown shell falls back to the most recent remaining one.
      setActiveShellId((cur) =>
        cur === id ? (remaining[remaining.length - 1] ?? null) : cur,
      );
    },
    [shells, setShells, setActiveShellId],
  );

  const handleCloseShell = useCallback(
    (id: string) => {
      window.electronAPI.terminalKill(id);
      removeShell(id);
    },
    [removeShell],
  );

  // A pty exiting — typing `exit`, archive-kill, or future idle eviction —
  // removes its entry. This is the single cleanup path, so killing a pty from
  // anywhere keeps the renderer's view (openedIds / shells) in sync.
  useEffect(
    () =>
      window.electronAPI.onTerminalExit((id) => {
        if (id.startsWith(shellPrefix)) removeShell(id);
        else if (id.startsWith(chatPrefix)) {
          setOpenedIds((ids) => ids.filter((x) => x !== id));
          // Claude exited. Don't leave an empty dock behind — close it. The
          // dock has no plain-shell fallback, so reopening (⌘J) reconnects.
          if (id === activeTerminalIdRef.current) setTerminalOpen(false);
        }
      }),
    [shellPrefix, chatPrefix, removeShell, setOpenedIds, setTerminalOpen],
  );

  // While the dock is open, keep the active chat terminal mounted. If there's
  // no live Claude for the selected session (e.g. you switched to a chat that
  // isn't running), there's nothing to show — close the dock rather than leave
  // a blank pane. ⌘J then reopens it, resuming Claude.
  useEffect(() => {
    if (!terminalOpen) return;
    if (activeTerminalId) ensureOpened(activeTerminalId);
    else setTerminalOpen(false);
  }, [terminalOpen, activeTerminalId, ensureOpened, setTerminalOpen]);

  // ── Session rename (modal; persisted in plan-desktop.json) ───
  const [renaming, setRenaming] = useState<{
    sessionId: string;
    name: string;
  } | null>(null);

  const handleRenameRequest = useCallback(
    (sessionId: string, currentTitle: string) =>
      setRenaming({ sessionId, name: currentTitle }),
    [],
  );

  const handleRenameSave = useCallback(
    async (sessionId: string, name: string) => {
      await window.electronAPI.renameSession(sessionId, name);
      refreshSessions();
    },
    [refreshSessions],
  );

  // ⌘⇧R renames the selected chat.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        if (!selectedSessionId) return;
        const current =
          sessions.find((s) => s.sessionId === selectedSessionId)?.title ?? "";
        setRenaming({ sessionId: selectedSessionId, name: current });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedSessionId, sessions]);

  // ⌘L focuses the chat composer.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        setTab("chat");
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ⌘N starts a new chat in this project.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNewChat]);

  // ⌘W closes the active content tab (no-op with nothing open — we don't fall
  // through to closing the window, which would be a jarring surprise).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "w"
      ) {
        if (!activeId) return;
        e.preventDefault();
        closeActive();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeId, closeActive]);

  const startTerminalResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = terminalHeight;
      const onMove = (ev: PointerEvent) => {
        // Drag up (negative dy) grows the terminal.
        const next = Math.min(
          Math.max(startH - (ev.clientY - startY), 120),
          window.innerHeight - 160,
        );
        setTerminalHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [terminalHeight],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        // The dock only ever shows the selected chat's Claude. No chat selected
        // → nothing to show, so do nothing (never open a bare shell).
        if (!selectedSessionId) return;
        // Selected chat not connected to Claude yet → connect it and reveal the
        // dock (works from any tab — Diffs/Files included). Already connected →
        // toggle; closing it hands focus back to the composer.
        if (!chatTerminalReady) {
          connectAndShowChat();
        } else if (terminalOpen) {
          setTerminalOpen(false);
          requestAnimationFrame(() => chatInputRef.current?.focus());
        } else {
          setTerminalOpen(true);
        }
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        handleNewShell();
      } else if (e.key === "Escape" && terminalOpen) {
        setTerminalOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    terminalOpen,
    setTerminalOpen,
    handleNewShell,
    selectedSessionId,
    chatTerminalReady,
    connectAndShowChat,
  ]);

  // Ctrl+Tab: cycle this project's chat sessions in a modal, committing on
  // Ctrl-release (Shift reverses). Lands you on the Chat tab. Ordered
  // most-recently-USED first (Alt-Tab style), per project, so the first tap
  // lands on the chat you were last in; before any chat is used this session it
  // keeps the default order. Archived chats are excluded.
  const activeSessions = useMemo(
    () => sessions.filter((s) => !s.archived),
    [sessions],
  );
  const mruScope = `sessions:${project.encoded}`;
  const mruVersion = useSyncExternalStore(
    subscribeMru,
    getMruVersion,
    getMruVersion,
  );
  const sessionsByMru = useMemo(
    () => orderByMru(mruScope, activeSessions, (s) => s.sessionId),
    [mruScope, activeSessions, mruVersion],
  );
  useEffect(() => {
    if (selectedSessionId) recordUse(mruScope, selectedSessionId);
  }, [mruScope, selectedSessionId]);
  const sessionIndex = Math.max(
    0,
    sessionsByMru.findIndex((s) => s.sessionId === selectedSessionId),
  );
  const sessionSwitcher = useTabSwitcher({
    id: "sessions",
    enabled: sessionsByMru.length > 1,
    triggerCode: "Tab",
    items: sessionsByMru,
    currentIndex: sessionIndex,
    onCommit: (s) => {
      openChatTab(s.sessionId);
      setTab("chat");
    },
  });

  return (
    <SidebarProvider
      defaultOpen={true}
      storageKey="plan.middleSidebar.open"
      shortcut={{ key: "e", meta: true }}
    >
      {confirmDialog}
      {runConfigOpen && (
        <RunConfigModal
          runCommand={runCommand}
          buildCommand={buildCommand}
          onSave={onSaveRunConfig}
          onClose={() => setRunConfigOpen(false)}
        />
      )}
      <Toaster position="bottom-right" closeButton />
      <CommandPalette
        open={paletteMode === "files"}
        placeholder="Search files in this project…"
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        items={fileItems}
        onClose={closePalette}
        emptyLabel={projectFilesLoading ? "Indexing…" : "No files"}
      />
      <CommandPalette
        open={paletteMode === "switch"}
        placeholder="Switch to a project or chat…"
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        items={switchItems}
        onClose={closePalette}
      />
      {sessionSwitcher.active && (
        <SwitcherOverlay
          title="Chat sessions"
          index={sessionSwitcher.index}
          items={sessionsByMru.map((s) => ({
            key: s.sessionId,
            label: s.title ?? "Untitled chat",
            sub: `${s.messageCount} message${s.messageCount === 1 ? "" : "s"}`,
          }))}
        />
      )}
      {renaming && (
        <RenameSessionDialog
          initialName={renaming.name}
          onSave={(name) => void handleRenameSave(renaming.sessionId, name)}
          onClose={() => setRenaming(null)}
        />
      )}
      <div className="flex h-full w-full flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceHeader
            project={project}
            projectsSidebarOpen={projectsSidebarOpen}
            branch={branch}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <TabBar
                tabs={tabs}
                activeId={activeId}
                titleFor={titleForTab}
                onActivate={setActive}
                onClose={closeTab}
              />
              {/* Each open tab keeps its own MOUNTED view, hidden via CSS when
                  inactive — so scroll position, expanded diffs and parsed
                  transcripts survive switching tabs. */}
              <div className="relative min-h-0 flex-1">
                {tabs.length === 0 && (
                  <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                    No tabs open — pick a chat, diff, or file from the sidebar.
                  </div>
                )}

                {/* Diff tabs */}
                {tabs.map((t) => {
                  if (t.kind !== "diff") return null;
                  const active = t.id === activeId;
                  const diff = getFileDiff(t.subPath, t.path);
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "absolute inset-0 min-h-0",
                        !active && "hidden",
                      )}
                    >
                      {diff ? (
                        <FileDiffViewer
                          encoded={project.encoded}
                          subPath={t.subPath}
                          file={diff}
                          mode={t.staged ? "staged" : "unstaged"}
                          active={active}
                          annotationsByFile={annotationsByFile}
                          setAnnotationsByFile={setAnnotationsByFile}
                          onStage={() => handleStageFile(t.path, t.subPath)}
                          onUnstage={() => handleUnstageFile(t.path, t.subPath)}
                          onDiscard={() => handleDiscardFile(t.path, t.subPath)}
                          onChanged={refreshDiff}
                          confirm={confirm}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                          No longer changed.
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* File tabs */}
                {tabs.map((t) => {
                  if (t.kind !== "file") return null;
                  const active = t.id === activeId;
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "absolute inset-0 min-h-0",
                        !active && "hidden",
                      )}
                    >
                      <FileViewer
                        encoded={project.encoded}
                        path={t.path}
                        annotations={annotationsByProjectFile[t.path] ?? []}
                        onAddAnnotation={(
                          selectedText,
                          startOffset,
                          endOffset,
                          startLine,
                          endLine,
                          comment,
                        ) =>
                          addProjectFileAnnotation(
                            t.path,
                            selectedText,
                            startOffset,
                            endOffset,
                            startLine,
                            endLine,
                            comment,
                          )
                        }
                        onUpdateAnnotation={(id, comment) =>
                          updateProjectFileAnnotation(t.path, id, comment)
                        }
                        onRemoveAnnotation={(id) =>
                          removeProjectFileAnnotation(t.path, id)
                        }
                        active={active}
                        revealTarget={
                          fileReveal && fileReveal.path === t.path
                            ? fileReveal
                            : null
                        }
                      />
                    </div>
                  );
                })}

                {/* Chat tabs: each keeps a mounted MessageList (transcript scroll
                    survives switching); the header + composer bind to the ACTIVE
                    chat, since you only type into one chat at a time. */}
                <div
                  className={cn(
                    "absolute inset-0 flex min-h-0 flex-col",
                    activeTab?.kind !== "chat" && "hidden",
                  )}
                >
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                    <span className="truncate text-[var(--text-secondary)]">
                      {sessions.find((s) => s.sessionId === selectedSessionId)
                        ?.title ??
                        session?.meta.title ??
                        selectedSessionId ??
                        "No session"}
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      {DEBUG_COPY_TERMINAL &&
                        selectedSessionId &&
                        chatTerminalReady && (
                          <button
                            onClick={copyTerminalDump}
                            title="Copy the terminal's rendered text — ⌘⇧D (debug)"
                            className="rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                          >
                            Copy terminal
                          </button>
                        )}
                      <span>
                        {session
                          ? `${turnCount} turn${turnCount === 1 ? "" : "s"}`
                          : ""}
                      </span>
                      {selectedSessionId &&
                        (chatTerminalReady ? (
                          <span
                            className={cn(
                              "flex items-center gap-1.5 rounded-md border px-2 py-1",
                              awaitingSelection
                                ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                                : "border-[var(--border)]",
                            )}
                            title={
                              awaitingSelection
                                ? "Claude may be waiting on a menu selection (no text box) — ⌘J to respond"
                                : !agentLive
                                  ? "Terminal is open, but no Claude process detected — ⌘J to view"
                                  : chatWorking
                                    ? "Claude is working in this chat — ⌘J to view"
                                    : "Claude is connected and idle in this chat — ⌘J to view"
                            }
                          >
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                awaitingSelection
                                  ? "animate-pulse bg-amber-500"
                                  : !agentLive
                                    ? "bg-[var(--text-tertiary)]"
                                    : chatWorking
                                      ? "animate-pulse bg-emerald-500"
                                      : "bg-emerald-500",
                              )}
                            />
                            <span>
                              {awaitingSelection
                                ? "Needs input"
                                : !agentLive
                                  ? "Terminal"
                                  : chatWorking
                                    ? "Working"
                                    : "Claude"}
                            </span>
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={connectAndShowChat}
                            title="Connect this chat to Claude (runs claude --resume) and open the terminal"
                            className="flex items-center gap-1.5"
                          >
                            <span>Connect</span>
                            <Kbd keys={["⌘", "J"]} />
                          </Button>
                        ))}
                    </div>
                  </div>
                  <div className="relative min-h-0 flex-1">
                    {tabs.map((t) => {
                      if (t.kind !== "chat") return null;
                      const active = t.id === activeId;
                      const ts = transcripts.get(t.sessionId);
                      return (
                        <div
                          key={t.id}
                          className={cn(
                            "absolute inset-0",
                            !active && "hidden",
                          )}
                        >
                          {ts ? (
                            <MessageList
                              messages={ts.messages}
                              encoded={project.encoded}
                              annotations={chatAnnotations}
                              onAddAnnotation={addChatAnnotation}
                              onUpdateAnnotation={updateChatAnnotation}
                              onRemoveAnnotation={removeChatAnnotation}
                              visible={active && activeTab?.kind === "chat"}
                              terminalReady={chatTerminalReady}
                              working={chatWorking}
                              onSendKeys={handleSendKeysToChat}
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
                              {NEW_SESSION_IDS.has(t.sessionId)
                                ? "New chat — send a message to start it."
                                : "Loading…"}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {activeTab?.kind === "chat" && selectedSessionId && (
                    <ChatInput
                      ref={chatInputRef}
                      sessionId={selectedSessionId}
                      projectEncoded={project.encoded}
                      inactive={!chatTerminalReady}
                      onStart={handleResumeChat}
                      onSend={handleSendChat}
                      blocked={awaitingSelection}
                      onBlocked={() => revealChatTerminal(selectedSessionId)}
                      autoFocus={NEW_SESSION_IDS.has(selectedSessionId)}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Unified compose buffer: code-diff + chat annotations combined.
                Persists across tabs. "Add to chat" drops it into the chat
                composer (so it's sent through the chat → terminal path). */}
            {totalComments > 0 && (
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-surface)] p-3">
                <MessageOutput
                  annotations={[]}
                  message={composedMessage}
                  count={totalComments}
                  onSend={handleAddToChat}
                  sendLabel="Add to chat"
                  onClear={handleClearComments}
                />
              </div>
            )}

            {/* Resizable docked terminal (⌘J). Kept mounted once opened so
                scrollback survives toggles; hidden (height 0) when closed. */}
            {terminalMounted && (
              <div
                className={cn(
                  "flex shrink-0 flex-col overflow-hidden border-t border-[var(--border)]",
                  !terminalOpen && "hidden",
                )}
                style={{ height: terminalOpen ? terminalHeight : 0 }}
              >
                <div
                  onPointerDown={startTerminalResize}
                  className="h-1.5 shrink-0 cursor-row-resize transition-colors hover:bg-[var(--border-strong)]"
                />
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {openedIds.map((tid) => {
                    const active = tid === activeTerminalId;
                    return (
                      <div
                        key={tid}
                        className={cn(
                          "absolute inset-0 overflow-hidden",
                          !active && "hidden",
                        )}
                      >
                        <TerminalPanel
                          ref={(h) => {
                            if (h) terminalRefs.current.set(tid, h);
                            else terminalRefs.current.delete(tid);
                          }}
                          id={tid}
                          encoded={project.encoded}
                          label={
                            tid.startsWith(chatPrefix) ? "Claude" : "Terminal"
                          }
                          initialCommand={initialCommandFor(tid)}
                          visible={terminalOpen && active}
                          fitSignal={terminalHeight}
                          onClose={() => setTerminalOpen(false)}
                          onReady={() => handleTerminalReady(tid)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <MiddleSidebar
          tab={tab}
          onTabChange={setTab}
          repos={repos}
          repoGroups={repoGroups}
          selectedFile={openKind === "diffs" ? selectedFile : null}
          activeFilePath={activeFilePath}
          onSelectFile={handleSelectFile}
          onStageFile={handleStageFile}
          onUnstageFile={handleUnstageFile}
          onDiscardFile={handleDiscardFile}
          onStageAll={handleStageAll}
          onUnstageAll={handleUnstageAll}
          onDiscardAll={handleDiscardAll}
          onStashAll={handleStashAll}
          syncTargets={syncTargets}
          onPush={handlePush}
          onCommit={handleCommit}
          filesLoading={filesLoading}
          diffAvailable={repos.length > 0}
          sessions={sessions}
          selectedSession={openKind === "chat" ? selectedSessionId : null}
          onSelectSession={handleSelectSession}
          onSetSessionArchived={handleSetSessionArchived}
          onRenameSession={handleRenameRequest}
          onNewChat={handleNewChat}
          sessionsLoading={sessionsLoading}
          projectFiles={projectFiles}
          projectFilesLoading={projectFilesLoading}
          selectedProjectFile={
            openKind === "files" ? selectedProjectFile : null
          }
          onSelectProjectFile={handleSelectProjectFile}
          onOpenSearchResult={handleOpenSearchResult}
          encoded={project.encoded}
          terminals={sidebarTerminals}
          // Default to the always-present Run tab when no shell is selected.
          activeTerminalId={activeShellId ?? `run:${project.encoded}`}
          onNewTerminal={handleNewShell}
          onSelectTerminal={handleSelectShell}
          onCloseTerminal={handleCloseShell}
          runCommand={runCommand}
          buildCommand={buildCommand}
          onConfigureRun={() => setRunConfigOpen(true)}
        />
      </div>
    </SidebarProvider>
  );
}

interface SwitchEntry {
  id: string;
  name: string;
  /** The project this entry belongs to (cwd for projects, name for chats). */
  project: string;
  badge: string;
  run: () => void;
}

/** True when focus is inside an embedded xterm terminal (dock or sidebar). */
function isTerminalFocused(): boolean {
  const el = document.activeElement;
  return !!el && !!el.closest(".xterm");
}

function fileBase(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function fileDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
function projShortName(p: ProjectEntry): string {
  return p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
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
