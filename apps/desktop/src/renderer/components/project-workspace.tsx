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
import { useAutoModeEnabled } from "../lib/auto-mode-settings";
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
import {
  isWorking,
  useTerminalWorking,
} from "../lib/terminal-activity-store";
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
import { mergeSession } from "../lib/merge-session";
import { bumpWorktreeRevision } from "../lib/worktree-revision";
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
  /** When true, Claude sessions start with `--permission-mode auto`. */
  autoMode?: boolean;
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
  autoMode,
  onSaveRunConfig,
}: Props) {
  // Global auto-mode default (Settings dialog). A project's own `autoMode`
  // override, when set, wins; otherwise this app-wide preference applies.
  const [globalAutoMode] = useAutoModeEnabled();
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
  // The pending-comments composer floats over file/diff content as a header-only
  // bar (minimized) and expands on chat. Auto-minimize fires ONLY on the
  // chat→file edge: switching between files preserves a manual expand, and
  // returning to chat resets it to expanded for the next file visit.
  const [composerCollapsed, setComposerCollapsed] = useState(
    () => activeTab != null && activeTab.kind !== "chat",
  );
  const prevTabKindRef = useRef(activeTab?.kind);
  useEffect(() => {
    const kind = activeTab?.kind;
    const prev = prevTabKindRef.current;
    prevTabKindRef.current = kind;
    if (kind === "chat") setComposerCollapsed(false);
    else if (prev === "chat") setComposerCollapsed(true);
  }, [activeTab?.kind]);

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
  // Whether the chat composer holds focus — the compose buffer only claims ⌘⏎
  // (and shows the hint) while it's blurred, so the chord never fights the box.
  const [chatInputFocused, setChatInputFocused] = useState(false);

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
        title: "Chat archived",
        description: `“${title}” was moved to archive.`,
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

  // Watch this project's real worktree on disk while its workspace is mounted.
  // Scoped to the active project (real repos are heavier to watch than the
  // session dirs), started/stopped here rather than eagerly for every project.
  useEffect(() => {
    void window.electronAPI.watchWorktree(project.encoded);
    return () => {
      void window.electronAPI.unwatchWorktree(project.encoded);
    };
  }, [project.encoded]);

  // Watcher: re-pull what's relevant. Debounced — a streaming session fires
  // events continuously, and refreshing (git + session list + transcript) on
  // every single one stalls the renderer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wantSelected = false;
    const changedSids = new Set<string>();
    const off = window.electronAPI.onWatcherEvent((e) => {
      if (e.encoded !== project.encoded) return;
      // A worktree change (file edit / git op on disk) bumps the content
      // revision so open diff/file/image panes re-fetch — refreshDiff below
      // covers the sidebar status, this covers the mounted content panes.
      if (e.kind === "worktree-changed") bumpWorktreeRevision(e.encoded);
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
    focusCaret?: boolean;
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

  // A Search-tab hit (or Cmd-P "path:line" jump): open the file in a tab and
  // scroll/highlight the match. Keeps the sidebar where it is (VS Code
  // behaviour) — only the content pane changes. `focusCaret` additionally lands
  // a focused caret on the line (the line-jump wants the file keyboard-ready).
  const handleOpenSearchResult = useCallback(
    (
      path: string,
      line: number,
      colStart: number,
      colEnd: number,
      focusCaret = false,
    ) => {
      openTab(makeFileTab(path));
      setFileReveal((prev) => ({
        path,
        line,
        colStart,
        colEnd,
        nonce: (prev?.nonce ?? 0) + 1,
        focusCaret,
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
    // VS Code-style "path:line" (and "path:line:col") suffix: a trailing
    // :number(s) targets a position; the rest fuzzy-matches the filename. A
    // colon not followed by digits is left in the query as a literal char.
    const raw = paletteQuery.trim();
    const posMatch = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
    const q = (posMatch ? posMatch[1] : raw).trim();
    const targetLine = posMatch ? parseInt(posMatch[2], 10) : null;
    const targetCol = posMatch?.[3] ? parseInt(posMatch[3], 10) : null;
    const matched = q
      ? fileFuse.search(q, { limit: 200 }).map((r) => r.item)
      : projectFiles.slice(0, 200);
    return matched.map((f) => ({
      id: f,
      label: fileBase(f),
      sublabel: fileDir(f),
      // Surface the resolved jump target so it's clear the suffix was parsed.
      badge:
        targetLine != null
          ? `:${targetLine}${targetCol != null ? `:${targetCol}` : ""}`
          : undefined,
      icon: <FileIcon name={fileBase(f)} />,
      onSelect: () => {
        if (targetLine != null) {
          // line is 1-based; col is 1-based in the query but 0-based offsets
          // in the reveal range. No col → place the caret at the line start.
          const col0 = targetCol != null ? Math.max(targetCol - 1, 0) : 0;
          handleOpenSearchResult(f, targetLine, col0, col0, true);
        } else {
          // openKind (not tab) drives the content pane — set both so the file
          // actually opens instead of just highlighting in the sidebar.
          handleSelectProjectFile(f);
        }
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
    handleOpenSearchResult,
    closePalette,
  ]);

  // ⌘K: switch across every project AND their chats (each chat tagged with the
  // project it belongs to). Chats are pulled from all projects on open.
  const [allChats, setAllChats] = useState<
    {
      sessionId: string;
      title: string;
      /** The auto-derived name, present only when the chat was renamed away from it. */
      originalTitle: string | null;
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
              // Only surface the original when a rename actually changed it.
              originalTitle:
                s.derivedTitle && s.derivedTitle !== s.title
                  ? s.derivedTitle
                  : null,
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
      originalName: c.originalTitle ?? undefined,
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
        // `originalName` lets a renamed chat still be found by its old name.
        keys: ["name", "originalName", "project"],
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
      hint: e.originalName,
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
  // Drives each chat tab's working icon: the terminal id of its agent, or null
  // for non-chat tabs (which have no agent to be busy).
  const termIdForTab = useCallback(
    (t: Tab): string | null =>
      t.kind === "chat" ? `${chatPrefix}${t.sessionId}` : null,
    [chatPrefix],
  );
  const initialCommandFor = (tid: string): string | undefined => {
    if (!tid.startsWith(chatPrefix)) return undefined;
    const sid = tid.slice(chatPrefix.length);
    // Brand-new chats start claude with a pre-chosen session id (nothing to
    // resume yet); existing ones resume their transcript.
    const flags = (autoMode ?? globalAutoMode) ? " --permission-mode auto" : "";
    return NEW_SESSION_IDS.has(sid)
      ? `claude --session-id ${sid}${flags}`
      : `claude --resume ${sid}${flags}`;
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
            title: "Message may be stuck",
            description: "Please check the terminal.",
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

  // "Claude is done" notifications are owned globally by the session-done
  // notifier (started at the app root), which watches every live session's
  // status — not just the one on screen. We deliberately don't fire a per-reply
  // notification here: a single turn appends several assistant messages (text,
  // then a tool call, then more text), which would notify several times.

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
          title: "Waiting on approval",
          description:
            "Claude may be paused on a tool-approval prompt in the terminal.",
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let proc: string | null = null;
      try {
        const st = await window.electronAPI.terminalStatus(tid);
        proc = st.running ? st.process : null;
        if (alive) setAgentProcess(proc);
      } catch {
        // Status unavailable — show the neutral state, not a wrong one.
        if (alive) setAgentProcess(null);
      }
      if (!alive) return;
      // Poll quickly until Claude is detected so the composer (which holds send
      // until the agent is live) unlocks right as the session finishes booting;
      // ease off to a slow heartbeat once it's up.
      const live = /claude|node/i.test(proc ?? "");
      timer = setTimeout(poll, live ? 5_000 : 1_000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
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
              title: `[detect] ${res.state} — ${
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
        title: "Waiting on a selection",
        description: "Claude has a menu open and needs you to choose an option.",
        actionLabel: "Open terminal",
        onAction: () => revealChatTerminal(selectedSessionId!),
      });
    } else if (!awaitingSelection) {
      autoRevealedRef.current = false;
    }
  }, [awaitingSelection, selectedSessionId, revealChatTerminal]);

  // Debug: capture the chat terminal's rendered text twice — once now (idle),
  // then again after 2s (scroll during the wait) — and put BOTH frames on the
  // clipboard so we can compare "idle" vs "while scrolling" and find a real
  // signal for "working" that scroll output can't fake (button + ⌘⇧D).
  const copyTerminalDump = useCallback(async () => {
    if (!selectedSessionId) return;
    const tid = `${chatPrefix}${selectedSessionId}`;
    // Snapshot both the rendered screen AND what the app currently believes the
    // state is: `working` is the timing signal (the one that mis-fires), and
    // `inputState` is main's screen-derived read. Capturing them WITH the frame
    // removes any ambiguity about what was shown vs. what we inferred.
    const snapshot = async (tag: string) => {
      const text = await window.electronAPI.terminalDump(tid);
      const working = isWorking(tid);
      let inputState = "unknown";
      try {
        inputState = (await window.electronAPI.terminalInputState(tid)).state;
      } catch {
        /* main may not classify it — leave as unknown */
      }
      return [
        `===== ${tag} =====`,
        `[app state] working=${working}  inputState=${inputState}`,
        "",
        text,
      ].join("\n");
    };
    try {
      const before = await snapshot("FRAME A (idle / before)");
      pushToast({ title: "Captured frame A — scroll now (2s)…" }, 2_000);
      await new Promise((r) => setTimeout(r, 2_000));
      const after = await snapshot("FRAME B (after 2s / while scrolling)");
      const combined = `${before}\n\n${after}`;
      await navigator.clipboard.writeText(combined);
      pushToast({ title: `Copied both frames (${combined.length} chars)` }, 3_000);
    } catch {
      pushToast({ title: "Couldn't copy the terminal" }, 3_000);
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

  // Comments cleared by the last "Add to chat", kept so ⌘Z in the composer can
  // put them back exactly where they were (see handleUndoAddToChat).
  const addToChatUndoRef = useRef<{
    byFile: typeof annotationsByFile;
    chat: typeof chatAnnotations;
    byProjectFile: typeof annotationsByProjectFile;
  } | null>(null);

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
      // Snapshot before clearing so an immediate ⌘Z can restore the comments.
      addToChatUndoRef.current = {
        byFile: annotationsByFile,
        chat: chatAnnotations,
        byProjectFile: annotationsByProjectFile,
      };
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
      annotationsByFile,
      chatAnnotations,
      annotationsByProjectFile,
      setAnnotationsByFile,
      setChatAnnotations,
      setAnnotationsByProjectFile,
    ],
  );

  // The composer pulled the just-added text back out (⌘Z) — restore the
  // comments it was made from, so they reappear in the panel.
  const handleUndoAddToChat = useCallback(() => {
    const snap = addToChatUndoRef.current;
    if (!snap) return;
    addToChatUndoRef.current = null;
    setAnnotationsByFile(snap.byFile);
    setChatAnnotations(snap.chat);
    setAnnotationsByProjectFile(snap.byProjectFile);
  }, [setAnnotationsByFile, setChatAnnotations, setAnnotationsByProjectFile]);

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

  // ⌘L focuses the chat composer. If the chat has no live terminal (e.g. an old
  // chat), start the session too — mirroring a click on the inactive input. The
  // composer parks the focus and lands the caret once the session turns it
  // editable; the send button stays disabled until then.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        setTab("chat");
        if (!chatTerminalReady) handleResumeChat();
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chatTerminalReady, handleResumeChat]);

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

  // ⌘⇧D cycles the content pane between a file and its diffs:
  //   file → unstaged diff → staged diff → file
  // Stages with no changes are skipped (so a file with only unstaged changes
  // cycles file → unstaged → file). The file view always exists, so coming
  // from a diff tab there's always a next stage and never a dead end; only the
  // file→diff step can fail, when the file has no changes at all — that's the
  // single case we toast. Each stage is its own tab (focus-or-create), matching
  // how clicking a file/diff in the sidebar opens a tab.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "d")
        return;
      if (!activeTab || activeTab.kind === "chat") return;
      e.preventDefault();

      // Resolve the repo (subPath) + repo-relative path + which stages are
      // changed, plus where we are in the cycle right now.
      let subPath: string;
      let repoPath: string;
      let projectRelPath: string;
      let hasUnstaged: boolean;
      let hasStaged: boolean;
      let current: "file" | "unstaged" | "staged";

      if (activeTab.kind === "file") {
        // A file tab's path is project-relative (repo subPath prefixed). Find
        // the status entry whose full path matches it.
        current = "file";
        projectRelPath = activeTab.path;
        let found: { subPath: string; path: string } | null = null;
        let status: GitFileStatus | undefined;
        for (const [sp, state] of filesByRepo) {
          const match = state.status.find(
            (s) => (sp ? `${sp}/${s.path}` : s.path) === activeTab.path,
          );
          if (match) {
            found = { subPath: sp, path: match.path };
            status = match;
            break;
          }
        }
        if (!found || !status || (!status.staged && !status.unstaged)) {
          pushToast(
            { title: "No diff found for that file." },
            3_000,
          );
          return;
        }
        subPath = found.subPath;
        repoPath = found.path;
        hasUnstaged = status.unstaged;
        hasStaged = status.staged;
      } else {
        subPath = activeTab.subPath;
        repoPath = activeTab.path;
        projectRelPath = subPath ? `${subPath}/${repoPath}` : repoPath;
        current = activeTab.staged ? "staged" : "unstaged";
        const status = filesByRepo
          .get(subPath)
          ?.status.find((s) => s.path === repoPath);
        hasUnstaged = status?.unstaged ?? false;
        hasStaged = status?.staged ?? false;
      }

      // The cycle is the existing stages in order; advance to the next one,
      // wrapping back to the file.
      const cycle: Array<"file" | "unstaged" | "staged"> = ["file"];
      if (hasUnstaged) cycle.push("unstaged");
      if (hasStaged) cycle.push("staged");
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];

      if (next === "file") openTab(makeFileTab(projectRelPath));
      else openTab(makeDiffTab(subPath, repoPath, next === "staged"));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, filesByRepo, openTab]);

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

  // Ctrl+Tab: cycle this worktree's open content-pane tabs in a modal,
  // committing on Ctrl-release (Shift reverses). Ordered most-recently-USED
  // first (Alt-Tab style), per worktree, so the first tap lands on the tab you
  // were last on; before any switch this session it keeps the tab-bar order.
  const tabsMruScope = `tabs:${project.encoded}`;
  const mruVersion = useSyncExternalStore(
    subscribeMru,
    getMruVersion,
    getMruVersion,
  );
  const tabsByMru = useMemo(
    () => orderByMru(tabsMruScope, tabs, (t) => t.id),
    [tabsMruScope, tabs, mruVersion],
  );
  useEffect(() => {
    if (activeId) recordUse(tabsMruScope, activeId);
  }, [tabsMruScope, activeId]);
  const tabIndex = Math.max(
    0,
    tabsByMru.findIndex((t) => t.id === activeId),
  );
  const tabSwitcher = useTabSwitcher({
    id: "tabs",
    enabled: tabsByMru.length > 1,
    triggerCode: "Tab",
    items: tabsByMru,
    currentIndex: tabIndex,
    onCommit: (t) => setActive(t.id),
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
      {/* Toast host lives at the app root (App.tsx) so it's always mounted. */}
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
      {tabSwitcher.active && (
        <SwitcherOverlay
          title="Open tabs"
          index={tabSwitcher.index}
          items={tabsByMru.map((t) => ({
            key: t.id,
            label: titleForTab(t),
            sub:
              t.kind === "chat"
                ? "Chat"
                : t.kind === "diff"
                  ? t.staged
                    ? "Diff · staged"
                    : "Diff"
                  : t.path,
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
                termIdFor={termIdForTab}
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
                            title="Capture frame, wait 2s (scroll now), capture again — both to clipboard — ⌘⇧D (debug)"
                            className="rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                          >
                            Copy 2 frames
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
                  {totalComments > 0 && (
                    <div className="shrink-0 px-3 pb-2">
                      <div className="mx-auto w-full max-w-[820px]">
                        <MessageOutput
                          annotations={[]}
                          message={composedMessage}
                          count={totalComments}
                          onSend={handleAddToChat}
                          sendLabel="Add to chat"
                          shortcutEnabled={
                            activeTab?.kind === "chat" && !chatInputFocused
                          }
                          onClear={handleClearComments}
                        />
                      </div>
                    </div>
                  )}
                  {activeTab?.kind === "chat" && selectedSessionId && (
                    <ChatInput
                      ref={chatInputRef}
                      sessionId={selectedSessionId}
                      projectEncoded={project.encoded}
                      inactive={!chatTerminalReady}
                      notReady={chatTerminalReady && !agentLive}
                      onStart={handleResumeChat}
                      onSend={handleSendChat}
                      blocked={awaitingSelection}
                      onBlocked={() => revealChatTerminal(selectedSessionId)}
                      autoFocus={NEW_SESSION_IDS.has(selectedSessionId)}
                      onFocusChange={setChatInputFocused}
                      onAddToChatUndo={handleUndoAddToChat}
                    />
                  )}
                </div>
                {/* Pending-comments composer. On a diff/file tab there's no chat
                    in context to add to, so it just displays the collected
                    comments (no "Add to chat" button). It floats as a card
                    pinned to the bottom of the content — the code keeps its full
                    height behind it rather than being shoved up by a docked bar.
                    The empty side margins stay click-through so the code
                    underneath remains selectable. */}
                {totalComments > 0 && activeTab?.kind !== "chat" && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-3">
                    <div className="pointer-events-auto mx-auto w-full max-w-[820px] rounded-lg shadow-2xl">
                      <MessageOutput
                        annotations={[]}
                        message={composedMessage}
                        count={totalComments}
                        onClear={handleClearComments}
                        collapsed={composerCollapsed}
                        onToggleCollapse={() => setComposerCollapsed((v) => !v)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

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
  /** A renamed chat's original auto-derived name, so search still matches it. */
  originalName?: string;
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
