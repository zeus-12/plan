import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation } from "@plan/shared/lib/store";
import type { FileDiff } from "@plan/shared/lib/diff-parser";
import { MessageOutput } from "@plan/shared/components/message-output";
import {
  SidebarProvider,
  useSidebar,
} from "@plan/shared/components/ui/sidebar";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import { TextShimmer } from "@plan/shared/components/ui/text-shimmer";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { cn, sameJson } from "@plan/shared/lib/utils";
import { basename, dirname, lastSegment } from "@plan/shared/lib/path";
import type {
  ProjectEntry,
  ParsedSession,
  DiscoveredRepo,
  CommandEntry,
  PushPreview,
  WorktreeRecord,
} from "../../shared-types";
import { MiddleSidebar } from "./middle-sidebar";
import { FileDiffViewer } from "./file-diff-viewer";
import { MessageList } from "./message-list";
import { FileViewer } from "./file-viewer";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { FileIcon } from "./file-icon";
import Fuse from "fuse.js";
import { useConfirm } from "./confirm-dialog";
import { TerminalPanel } from "./terminal-panel";
import {
  useProjectAnnotations,
  type ChatAnchor,
  type ChatAnnotation,
  type ProjectAnnotations,
  type ProjectFileAnnotationInput,
} from "../lib/annotation-store";
import { chatTerminalId, chatTerminalPrefix } from "../../terminal-ids";
import {
  clearSessionUnread,
  markSessionUnread,
  setViewedSession,
} from "../lib/unread-response-store";
import { useTerminalHeight } from "../lib/terminal-store";
import { useTerminalRegistry } from "../lib/use-terminal-registry";
import { useWorkspaceTabs } from "../lib/use-workspace-tabs";
import { useWorkingTree, repoDisplayName } from "../lib/use-working-tree";
import { useChatSession } from "../lib/use-chat-session";
import {
  retryableApiErrorAtEnd,
  sessionLimitAtEnd,
  sessionLimitResetText,
} from "../../api-errors";
import {
  CONTINUE_TEXT,
  useAutoContinueInFlight,
} from "../lib/auto-continue-watcher";
import {
  getProjectTabs,
  openProjectTab,
  closeProjectTab,
  replaceProjectTab,
  makeChatTab,
  makeDiffTab,
  makeFileTab,
  makePrTab,
  makeScratchTab,
  chatTabId,
  type Tab,
} from "../lib/tabs-store";
import { cachedPrTitle } from "../lib/pr-store";
import { forgetSession, rekeySession } from "../lib/composer-memory";
import { PrView } from "./pr-view";
import { TabBar } from "./tab-bar";
import { ScratchEditor } from "./scratch-editor";
import { ChatInput, type ChatInputHandle } from "./chat-input";
import { RenameSessionDialog } from "./rename-session-dialog";
import { CommandsConfigModal } from "./commands-config-modal";
import { PushModal } from "./push-modal";
import { ThemeMenu } from "./theme-menu";
import { OpenInMenu } from "./open-in-menu";
import { getDefaultExternalApp } from "../lib/external-apps-store";
import { SwitcherOverlay } from "./switcher-overlay";
import { useTabSwitcher } from "../lib/use-tab-switcher";
import { mergeSession } from "../lib/merge-session";
import { fetchTranscript, dropTranscript } from "../lib/transcript-sync";
import { bumpWorktreeRevision } from "../lib/worktree-revision";
import {
  getCachedSessions,
  setCachedSessions,
  getCachedTranscripts,
  setCachedTranscripts,
} from "../lib/session-cache";
import { pushToast } from "../lib/toast-store";
import {
  markNewSession,
  isNewSession,
  forgetNewSession,
} from "../lib/new-session-ids";

// Stable identity for the middle sidebar's ⌘E toggle shortcut (see the keyed
// SidebarProvider below). A module constant so it isn't a fresh object each
// render — the provider memoizes its context on `shortcut`.
const MIDDLE_SIDEBAR_SHORTCUT = { key: "e", meta: true } as const;

import type { SessionListItem } from "./session-list";
import type { FileEntry, RepoFileGroup } from "./file-list";

interface Props {
  project: ProjectEntry;
  repos: DiscoveredRepo[];
  /**
   * Whether this workspace is the one on screen. Recently-visited workspaces
   * stay MOUNTED (hidden via CSS) instead of being torn down on every switch —
   * so switching back is instant — but that means several ProjectWorkspaces are
   * live at once. All of them share the global `window` keydown listeners, so
   * every keyboard-shortcut handler (and the Ctrl+Tab switcher and the ⌘E middle
   * sidebar) is gated on `active`: a background workspace must not act on a
   * keystroke meant for the visible one. Encoded-scoped subscriptions (the disk
   * watcher, terminal-exit) already ignore other workspaces' events, so they
   * don't need gating.
   */
  active: boolean;
  projectsSidebarOpen: boolean;
  /** All projects + a switch callback — drives the ⌘K palette. */
  projects: ProjectEntry[];
  onSelectProject: (encoded: string) => void;
  /** Every project's worktrees (keyed by parent encoded) — listed in the ⌘K palette. */
  worktreesByProject: Map<string, WorktreeRecord[]>;
  /** Switch focus to a worktree from the ⌘K palette. */
  onSelectWorktree: (projectEncoded: string, worktreeId: string) => void;
  /** Project-level Run command list (shared across this project's worktrees). */
  runEntries: CommandEntry[];
  /** Project-level Build command list (the Build tab shows only in a worktree). */
  buildEntries: CommandEntry[];
  /** Whether the current view is a worktree — gates the Build tab. */
  isWorktree: boolean;
  /** Persist the Run / Build command lists to the project (parent-keyed defaults). */
  onSaveRun: (entries: CommandEntry[]) => Promise<void> | void;
  onSaveBuild: (entries: CommandEntry[]) => Promise<void> | void;
  /**
   * Move a chat session out of this view into another worktree (or the live
   * copy). Omitted when there's nowhere to move it (project has no worktrees).
   */
  onMoveSession?: (sessionId: string, title: string) => void;
}

/**
 * What "Open in…" acts on: the file behind a file/diff tab, or the workspace
 * itself for anything else (chat, search, scratch, a PR). Shared by the header
 * control and the ⌘⇧O handler so the two can't drift.
 */
function openTarget(tab: Tab | null | undefined): {
  relPath: string | null;
  subPath: string;
} {
  if (tab?.kind === "file") return { relPath: tab.path, subPath: "" };
  if (tab?.kind === "diff") return { relPath: tab.path, subPath: tab.subPath };
  return { relPath: null, subPath: "" };
}

function WorkspaceHeader({
  project,
  projectsSidebarOpen,
  branch,
  repoLabel,
  activeTab,
}: {
  project: ProjectEntry;
  projectsSidebarOpen: boolean;
  branch: string | null;
  /** Set in multi-repo projects to say which repo the branch belongs to. */
  repoLabel: string | null;
  /** Decides whether "Open in…" targets a file or the whole project. */
  activeTab: Tab | null | undefined;
}) {
  const target = openTarget(activeTab);
  const middle = useSidebar();
  const shortName = lastSegment(project.cwd);

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
            {repoLabel && (
              <>
                {repoLabel}
                <span className="text-[var(--text-tertiary)]"> · </span>
              </>
            )}
            {branch}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <OpenInMenu
          encoded={project.encoded}
          relPath={target.relPath}
          subPath={target.subPath}
        />
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

/* ── Memoized tab panes ───────────────────────────────────────
 * Every open tab keeps its content MOUNTED (hidden via CSS) so scroll, parsed
 * transcripts and highlighted diffs survive tab switches. The catch: without
 * memoization, ANY ProjectWorkspace re-render — clicking a different tab, a
 * 250ms watcher tick, a terminal-status poll — re-rendered EVERY mounted pane.
 * With a large file/diff or many tabs that's the multi-second freeze. These
 * wrappers take a stable `tab` plus stable (useCallback) handlers and bind the
 * per-tab callbacks INTERNALLY, so a pane only re-renders when its OWN data
 * changes. The active-only props (`working`/`terminalReady`/`active`) are passed
 * as `false` to inactive panes so a working-state flip touches just one. */

const EMPTY_ANN: Annotation[] = [];

type RevealTarget = {
  line: number;
  colStart: number;
  colEnd: number;
  nonce: number;
  focusCaret?: boolean;
} | null;

const DiffTabPane = memo(function DiffTabPane({
  tab,
  active,
  encoded,
  diff,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onChanged,
  confirm,
}: {
  tab: Extract<Tab, { kind: "diff" }>;
  active: boolean;
  encoded: string;
  diff: FileDiff | null;
  onStageFile: (path: string, subPath: string) => void;
  onUnstageFile: (path: string, subPath: string) => void;
  onDiscardFile: (path: string, subPath: string) => void;
  onChanged: () => void;
  confirm: (opts: {
    title: string;
    description?: string;
    confirmLabel?: string;
  }) => Promise<boolean>;
}) {
  return (
    <div className={cn("absolute inset-0 min-h-0", !active && "hidden")}>
      {diff ? (
        <FileDiffViewer
          encoded={encoded}
          subPath={tab.subPath}
          file={diff}
          mode={tab.staged ? "staged" : "unstaged"}
          active={active}
          onStage={() => onStageFile(tab.path, tab.subPath)}
          onUnstage={() => onUnstageFile(tab.path, tab.subPath)}
          onDiscard={() => onDiscardFile(tab.path, tab.subPath)}
          onChanged={onChanged}
          confirm={confirm}
        />
      ) : (
        <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          No longer changed.
        </div>
      )}
    </div>
  );
});

const FileTabPane = memo(function FileTabPane({
  tab,
  active,
  encoded,
  annotations,
  revealTarget,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: {
  tab: Extract<Tab, { kind: "file" }>;
  active: boolean;
  encoded: string;
  annotations: Annotation[];
  revealTarget: RevealTarget;
  onAddAnnotation: (path: string, input: ProjectFileAnnotationInput) => void;
  onUpdateAnnotation: (path: string, id: string, comment: string) => void;
  onRemoveAnnotation: (path: string, id: string) => void;
}) {
  return (
    <div className={cn("absolute inset-0 min-h-0", !active && "hidden")}>
      <FileViewer
        encoded={encoded}
        path={tab.path}
        annotations={annotations}
        onAddAnnotation={(s, so, eo, sl, el, c) =>
          onAddAnnotation(tab.path, {
            selectedText: s,
            startOffset: so,
            endOffset: eo,
            startLine: sl,
            endLine: el,
            comment: c,
          })
        }
        onUpdateAnnotation={(id, c) => onUpdateAnnotation(tab.path, id, c)}
        onRemoveAnnotation={(id) => onRemoveAnnotation(tab.path, id)}
        active={active}
        revealTarget={revealTarget}
      />
    </div>
  );
});

const ChatTabPane = memo(function ChatTabPane({
  tab,
  active,
  encoded,
  transcript,
  annotations,
  working,
  terminalReady,
  isNew,
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  onSendKeys,
}: {
  tab: Extract<Tab, { kind: "chat" }>;
  active: boolean;
  encoded: string;
  transcript: ParsedSession | undefined;
  annotations: ChatAnnotation[];
  working: boolean;
  terminalReady: boolean;
  isNew: boolean;
  onAddAnnotation: (
    anchor: ChatAnchor,
    selectedText: string,
    comment: string,
  ) => void;
  onUpdateAnnotation: (id: string, comment: string) => void;
  onRemoveAnnotation: (id: string) => void;
  onSendKeys: (keys: string[]) => void;
}) {
  return (
    <div className={cn("absolute inset-0", !active && "hidden")}>
      {transcript ? (
        <MessageList
          messages={transcript.messages}
          sessionId={tab.sessionId}
          encoded={encoded}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          visible={active}
          terminalReady={terminalReady}
          working={working}
          onSendKeys={onSendKeys}
        />
      ) : (
        <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          {isNew ? (
            "New chat — send a message to start it."
          ) : (
            <TextShimmer duration={2.4}>Loading…</TextShimmer>
          )}
        </div>
      )}
    </div>
  );
});

function ProjectWorkspaceImpl({
  project,
  repos,
  active,
  projectsSidebarOpen,
  projects,
  onSelectProject,
  worktreesByProject,
  onSelectWorktree,
  runEntries,
  buildEntries,
  isWorktree,
  onSaveRun,
  onSaveBuild,
  onMoveSession,
}: Props) {
  // Keep the latest `active` in a ref so the global keydown handlers can read it
  // WITHOUT `active` in their dependency arrays — otherwise every switch would
  // tear down and re-add ~10 window listeners. `activeRef.current` is always the
  // current value (assigned on each render, before the handlers can fire).
  const activeRef = useRef(active);
  activeRef.current = active;
  // Session list state lives up here because the tab hook's Ctrl+Tab switcher
  // lists sessions without an open tab. Seeded from the per-encoded cache so
  // revisiting a worktree paints instantly (then refreshes in the background)
  // instead of flashing "Loading…" through a full re-list on every remount.
  const [sessions, setSessions] = useState<SessionListItem[]>(
    () => getCachedSessions(project.encoded) ?? [],
  );
  // Only show the loading placeholder if this worktree was never loaded.
  const [sessionsLoading, setSessionsLoading] = useState(
    () => getCachedSessions(project.encoded) === null,
  );

  // VSCode model: `tab` chooses which LIST shows in the right sidebar; the
  // content pane is driven by the open-tab list (single source of truth) —
  // see useWorkspaceTabs for the full contract.
  const {
    tab,
    setTab,
    tabs,
    activeId,
    activeTab,
    openTab,
    closeTab,
    closeActive,
    setActive,
    openChatTab,
    openKind,
    selectedSessionId,
    selectedFile,
    selectedProjectFile,
    activePr,
    activeFilePath,
    switcherEntries,
    switcherCurrentIndex,
    firstSessionSwitcherId,
    hasOpenTabs,
  } = useWorkspaceTabs(project.encoded, sessions);

  // Panes stay mounted once created (scroll position, expanded diffs, undo
  // history survive tab switches) — but they are created LAZILY: a tab's pane
  // mounts the first time that tab is active during this workspace mount.
  // Mounting every open tab's transcript/diff/PR view in one commit made a
  // cold project/worktree switch a multi-second render; a never-yet-activated
  // tab has no view state to preserve, so deferring costs nothing.
  const everActiveTabIds = useRef(new Set<string>());
  if (activeId) everActiveTabIds.current.add(activeId);
  const paneMounted = (id: string) => everActiveTabIds.current.has(id);
  // Header branch pill. A single-repo project always shows its branch. A
  // multi-repo project shows a branch only when the active tab pins a file to
  // Tell the unread store which session you're actually looking at, so its
  // green "replied" badge clears when — and only when — this workspace is the
  // active one AND a chat is the on-screen pane. Gated on `active` because the
  // keep-alive pool mounts several workspaces at once; only the visible one is
  // "viewed". Cleanup (and the inactive branch) reports null so a background
  // workspace never claims to be on screen.
  useEffect(() => {
    if (!active) return;
    setViewedSession(
      openKind === "chat" && selectedSessionId
        ? chatTerminalId(project.encoded, selectedSessionId)
        : null,
    );
    return () => setViewedSession(null);
  }, [active, openKind, selectedSessionId, project.encoded]);

  // one specific repo — never an arbitrary repo's branch.
  const headerRepo = useMemo(() => {
    if (repos.length === 1) return repos[0];
    if (activeTab?.kind === "diff") {
      return repos.find((r) => r.subPath === activeTab.subPath) ?? null;
    }
    if (activeTab?.kind === "file") {
      // File paths are project-relative; the repo owning the file is the one
      // whose subPath is the longest prefix (nested repos beat the root repo).
      let best: DiscoveredRepo | null = null;
      for (const r of repos) {
        const inRepo =
          r.subPath === "" || activeTab.path.startsWith(`${r.subPath}/`);
        if (inRepo && (!best || r.subPath.length > best.subPath.length)) {
          best = r;
        }
      }
      return best;
    }
    return null;
  }, [repos, activeTab]);
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

  // Opening a chat (sidebar click, tab switch, Ctrl+Tab) should land the caret
  // in the composer so the user can type straight away — no click required.
  // Keyed on the session id: every switch to a chat re-runs this. `focus()`
  // parks itself if the composer isn't live yet (old chat), so it works whether
  // the session is already running or being spun up.
  useEffect(() => {
    if (!selectedSessionId || !activeRef.current) return;
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [selectedSessionId]);

  const { confirm, dialog: confirmDialog } = useConfirm();

  // Repo whose push dialog is open — pushing goes through it, never directly.
  // The preview is read BEFORE mounting so the dialog opens at its final size
  // instead of growing once the commit list lands.
  const [pushDialog, setPushDialog] = useState<{
    subPath: string;
    preview: PushPreview;
  } | null>(null);
  const pushPreviewPending = useRef(false);

  const openPushDialog = useCallback(
    async (subPath: string) => {
      if (pushPreviewPending.current) return;
      pushPreviewPending.current = true;
      try {
        const preview = await window.electronAPI.pushPreview(
          project.encoded,
          subPath,
        );
        setPushDialog({ subPath, preview });
      } finally {
        pushPreviewPending.current = false;
      }
    },
    [project.encoded],
  );

  // ── Git working tree (per-repo diff/status + ops) ────────────
  // See useWorkingTree: ops route via subPath, every op re-pulls git state,
  // and open diff tabs follow their file across staged/unstaged/committed.
  const {
    filesLoading,
    refreshDiff,
    repoGroups,
    syncTargets,
    fileStages,
    getFileDiff,
    stageFile: handleStageFile,
    unstageFile: handleUnstageFile,
    discardFile: handleDiscardFile,
    stageAll: handleStageAll,
    unstageAll: handleUnstageAll,
    discardAll: handleDiscardAll,
    stashAll: handleStashAll,
    push: handlePush,
    commit: handleCommit,
  } = useWorkingTree({
    encoded: project.encoded,
    cwd: project.cwd,
    repos,
    confirm,
  });

  // Comments persist per-project across first-sidebar switches (the workspace
  // is keyed by `encoded` and remounts on switch). Both the diff annotations
  // (keyed by "subPath::path") and the chat annotations come from this store.
  const {
    chatAnnotations,
    annotationsByProjectFile,
    totalComments,
    composedMessage,
    addProjectFileAnnotation,
    updateProjectFileAnnotation,
    removeProjectFileAnnotation,
    addChatAnnotation,
    updateChatAnnotation,
    removeChatAnnotation,
    snapshotAndClearAll,
    restoreAll,
    clearAll,
  } = useProjectAnnotations(project.encoded);

  // ── Sessions state ───────────────────────────────────────────
  // (`sessions` itself is declared above the tab hook, which needs it.)
  // Parsed transcripts for every OPEN chat tab, keyed by session id, so each
  // chat tab keeps a live, mounted MessageList (its scroll survives switching
  // tabs). The watcher refreshes whichever open transcripts change. The active
  // chat tab's transcript is exposed as `session` for the status/notify logic.
  const [transcripts, setTranscripts] = useState<Map<string, ParsedSession>>(
    () => getCachedTranscripts(project.encoded) ?? new Map(),
  );
  const session = useMemo(
    () =>
      selectedSessionId ? (transcripts.get(selectedSessionId) ?? null) : null,
    [transcripts, selectedSessionId],
  );
  // Persist parsed transcripts so a worktree remount re-hydrates open chats
  // instantly instead of re-reading/re-parsing them over IPC.
  useEffect(() => {
    setCachedTranscripts(project.encoded, transcripts);
  }, [project.encoded, transcripts]);
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

  // `/branch` follow. When the composer sends `/branch`, its `claude` forks into
  // a new session id in the SAME pty — leaving the tab bound to a session the
  // process left (the mismatch we're fixing). We record the branching session +
  // a fingerprint of its conversation here; when the fork's transcript appears,
  // followBranch (defined below, reached via a ref so the rarely-resubscribed
  // watcher always calls the latest) rebinds the tab and the pty to the fork.
  const pendingBranchRef = useRef<{
    fromSid: string;
    rootUuid: string | null;
  } | null>(null);
  const followBranchRef = useRef<(candidateSids: string[]) => void>(() => {});

  const refreshSessions = useCallback(async () => {
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
      // Watcher ticks mostly return identical content — keep the identity so
      // the sidebar/session-list memos don't re-render while streaming.
      setSessions((prev) => (sameJson(prev, enriched) ? prev : enriched));
      // Cache the loaded list so a remount (worktree switch) hydrates instantly.
      setCachedSessions(project.encoded, enriched);
      // No auto-select: the content pane only shows what you've opened as a
      // tab. A fresh worktree opens to an empty pane (click a chat to open it).
    } finally {
      // Clears the never-loaded placeholder; a same-value set is a React no-op,
      // so background refreshes don't re-render through this.
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
        forgetSession(sessionId);
        // Unread now outlives the pty, so putting a chat away has to retire its
        // badge explicitly — otherwise it would sit in the rollup unreachable.
        clearSessionUnread(chatTerminalId(project.encoded, sessionId));
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
      if (!activeRef.current) return;
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

  // ⌘⇧U: flag the open chat unread and close its tab — the "I'll come back to
  // this" move, same state the row's "Mark as unread" sets.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "u"
      ) {
        if (openKind !== "chat" || !selectedSessionId) return;
        e.preventDefault();
        markSessionUnread(chatTerminalId(project.encoded, selectedSessionId));
        closeTab(chatTabId(selectedSessionId));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openKind, selectedSessionId, project.encoded, closeTab]);

  const refreshTranscript = useCallback(
    async (sid: string) => {
      // Incremental: main folds the JSONL behind a byte cursor and returns only
      // appended messages; transcript-sync assembles the full ParsedSession
      // (prefix objects keep their identity by construction).
      const parsed = await fetchTranscript(project.encoded, sid);
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
          dropTranscript(project.encoded, sid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [chatSessionIds, refreshTranscript, project.encoded]);

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
    // What the window's events actually touched — git spawns (diff/status) are
    // only worth paying when the worktree changed, and the session list only
    // when a JSONL did. A streaming turn is almost all session events, so this
    // keeps the 250ms loop off git entirely between file edits.
    let sawWorktree = false;
    let sawSession = false;
    const changedSids = new Set<string>();
    // Freshly-appeared transcripts this tick — candidates for a `/branch` follow.
    const newSids = new Set<string>();
    const off = window.electronAPI.onWatcherEvent((e) => {
      if (e.encoded !== project.encoded) return;
      if (e.kind === "new-session" && e.sessionId) newSids.add(e.sessionId);
      // A worktree change (file edit / git op on disk) bumps the content
      // revision so open diff/file/image panes re-fetch — refreshDiff below
      // covers the sidebar status, this covers the mounted content panes.
      if (e.kind === "worktree-changed") {
        bumpWorktreeRevision(e.encoded);
        sawWorktree = true;
      } else {
        sawSession = true;
      }
      // Refresh the transcript of any OPEN chat tab whose JSONL changed.
      if (e.sessionId && chatSessionIdsRef.current.includes(e.sessionId)) {
        changedSids.add(e.sessionId);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (sawWorktree) refreshDiff();
        if (sawSession) refreshSessions();
        sawWorktree = false;
        sawSession = false;
        for (const sid of changedSids) void refreshTranscript(sid);
        changedSids.clear();
        // If a `/branch` is armed, see whether one of the new transcripts is its
        // fork and, if so, follow the pty to it.
        if (newSids.size > 0 && pendingBranchRef.current) {
          followBranchRef.current([...newSids]);
        }
        newSids.clear();
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
  // The input binds to the live `paletteQuery`, but the heavy results build
  // (Fuse search + up to 200 rows, each with a FileIcon) runs off a DEFERRED
  // copy. Typing stays responsive — keystrokes update the field immediately and
  // the list catches up in a low-priority, interruptible render instead of
  // re-running the whole filter on every key.
  const deferredPaletteQuery = useDeferredValue(paletteQuery);
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
    const raw = deferredPaletteQuery.trim();
    const posMatch = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
    const q = (posMatch ? posMatch[1] : raw).trim();
    const targetLine = posMatch ? parseInt(posMatch[2], 10) : null;
    const targetCol = posMatch?.[3] ? parseInt(posMatch[3], 10) : null;
    const matched = q
      ? fileFuse.search(q, { limit: 200 }).map((r) => r.item)
      : projectFiles.slice(0, 200);
    return matched.map((f) => ({
      id: f,
      label: basename(f),
      sublabel: dirname(f),
      // Surface the resolved jump target so it's clear the suffix was parsed.
      badge:
        targetLine != null
          ? `:${targetLine}${targetCol != null ? `:${targetCol}` : ""}`
          : undefined,
      icon: <FileIcon name={basename(f)} />,
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
    deferredPaletteQuery,
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
              projectName: lastSegment(p.cwd),
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
        name: lastSegment(p.cwd),
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
    // Worktrees, tagged with their parent project's name (the inline sublabel),
    // exactly like chats. Skip any whose parent project is gone/archived.
    const projectNameOf = new Map(
      projects.map((p) => [p.encoded, lastSegment(p.cwd)]),
    );
    const worktreeEntries: SwitchEntry[] = [];
    for (const [projectEncoded, list] of worktreesByProject) {
      const projectName = projectNameOf.get(projectEncoded);
      if (!projectName) continue;
      for (const w of list) {
        worktreeEntries.push({
          id: `w:${w.id}`,
          name: w.name,
          project: projectName,
          badge: "worktree",
          run: () => onSelectWorktree(projectEncoded, w.id),
        });
      }
    }
    return [...projEntries, ...chatEntries, ...worktreeEntries];
  }, [
    projects,
    allChats,
    worktreesByProject,
    project.encoded,
    onSelectProject,
    onSelectWorktree,
    openChatTab,
  ]);

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
    const q = deferredPaletteQuery.trim();
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
  }, [
    paletteMode,
    deferredPaletteQuery,
    switchFuse,
    switchEntries,
    closePalette,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
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

  const handleSelectFile = useCallback(
    (subPath: string, path: string, staged: boolean) => {
      openTab(makeDiffTab(subPath, path, staged));
    },
    [openTab],
  );

  const handleOpenPr = useCallback(
    (subPath: string, number: number) => {
      openTab(makePrTab(subPath, number));
    },
    [openTab],
  );

  // Stable so it doesn't break MiddleSidebar's memo (composer keystrokes).
  const prRepoName = useCallback(
    (repo: DiscoveredRepo) => repoDisplayName(repo, project.cwd),
    [project.cwd],
  );

  // A tab's display title — derived from live data so a renamed chat / moved
  // file stays current (titles are never stored on the tab itself).
  const titleForTab = useCallback(
    (t: Tab): string => {
      if (t.kind === "chat") {
        return (
          sessions.find((s) => s.sessionId === t.sessionId)?.title ??
          transcripts.get(t.sessionId)?.meta.title ??
          (isNewSession(t.sessionId) ? "New chat" : "Chat")
        );
      }
      if (t.kind === "scratch") return "Scratchpad";
      if (t.kind === "pr") {
        const title = cachedPrTitle(project.encoded, t.subPath, t.number);
        return title ? `#${t.number} ${title}` : `PR #${t.number}`;
      }
      return t.path.split("/").pop() || t.path;
    },
    [sessions, transcripts, project.encoded],
  );

  // ── Terminals (⌘J) ───────────────────────────────────────────
  // Each project has a default terminal; each chat the user "resumes" gets its
  // own terminal running `claude --resume <id>`; the sidebar's Terminals
  // section adds scratch shells. All opened terminals stay mounted (hidden) so
  // scrollback survives switching between them. Terminal view-state persists
  // per project across first-sidebar switches.
  const {
    openedIds,
    terminalOpen,
    setTerminalOpen,
    shells,
    activeShellId,
    setActiveShellId,
    ensureOpened,
    rekeyChatTerminal,
    shellNumber,
    newShell,
    selectShell,
    closeShell,
  } = useTerminalRegistry(project.encoded, (tid) => {
    // Claude exited. Don't leave an empty dock behind — close it. The dock
    // has no plain-shell fallback, so reopening (⌘J) reconnects.
    if (tid === activeTerminalIdRef.current) setTerminalOpen(false);
  });
  // Dock height is a single global, persisted value — shared across projects.
  const [terminalHeight, setTerminalHeight] = useTerminalHeight();
  // The dock is mounted whenever there's at least one opened terminal.
  const terminalMounted = openedIds.length > 0;

  const chatPrefix = chatTerminalPrefix(project.encoded);
  // Drives each chat tab's working icon: the terminal id of its agent, or null
  // for non-chat tabs (which have no agent to be busy).
  const termIdForTab = useCallback(
    (t: Tab): string | null =>
      t.kind === "chat" ? `${chatPrefix}${t.sessionId}` : null,
    [chatPrefix],
  );
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

  // Record a `/branch` submit so the watcher can follow the fork. Stable so
  // useChatSession's send callback doesn't churn.
  const handleBranchCommand = useCallback(
    (fromSid: string, rootUuid: string | null) => {
      pendingBranchRef.current = { fromSid, rootUuid };
    },
    [],
  );

  // Follow a `/branch`: when one of the tick's new transcripts is the fork of
  // the armed session, re-key its live pty and move the tab onto it in place.
  const followBranch = useCallback(
    async (candidateSids: string[]) => {
      const pending = pendingBranchRef.current;
      // No fingerprint → can't confirm the fork; don't guess (a wrong rebind is
      // worse than none). The armed marker just lingers until a real branch.
      if (!pending || !pending.rootUuid) return;
      for (const b of candidateSids) {
        if (b === pending.fromSid) continue;
        // A branch copies the parent's history, so the fork shares its root
        // message uuid. That equality is the reliable confirm that THIS new
        // transcript is the fork — not timing or "newest file" guesswork.
        const parsed = await fetchTranscript(project.encoded, b);
        const root = parsed?.messages.find((m) => m.uuid)?.uuid ?? null;
        if (!root || root !== pending.rootUuid) continue;
        // The same live pty is on B now: re-key it (main + opened set), then
        // swap the tab A→B in place (keeps position + focus). The old session
        // stays a frozen history row — resuming it later spawns its own pty.
        const ok = await rekeyChatTerminal(
          `${chatPrefix}${pending.fromSid}`,
          `${chatPrefix}${b}`,
        );
        if (!ok) return; // no live pty actually moved — leave B as a new session
        // The parent (A) was branched, so its transcript exists on disk AND its
        // pty just moved to B — it now has no live pty of its own. If A was a
        // brand-new chat it's still flagged "new" (→ `--session-id A`); clear
        // that so reopening it RESUMES instead of trying to re-create an id
        // that's already on disk ("Session ID already in use"). B is claude's
        // own id, never app-marked-new, so it already resumes correctly.
        forgetNewSession(pending.fromSid);
        // The composer's memory follows the conversation, not the id it used to
        // have — what was typed seconds before the fork stays undoable.
        rekeySession(pending.fromSid, b);
        replaceProjectTab(
          project.encoded,
          chatTabId(pending.fromSid),
          makeChatTab(b),
        );
        void refreshTranscript(b);
        pendingBranchRef.current = null;
        return;
      }
    },
    [project.encoded, chatPrefix, rekeyChatTerminal, refreshTranscript],
  );
  followBranchRef.current = followBranch;

  // The selected chat's lifecycle: which engine drives it and what that engine
  // supports (the dock ⌘J mirrors activeTerminalId — never a plain shell),
  // sending + the stuck-message watchdog, and the observed activity signals.
  // See useChatSession.
  const {
    chatTerminalReady,
    activeTerminalId,
    capabilities: chatCapabilities,
    connectChat,
    startChatFor,
    sendChat,
    sendKeysToChat,
    agentLive,
    chatWorking,
    awaitingSelection,
    turnCount,
  } = useChatSession({
    encoded: project.encoded,
    selectedSessionId,
    session,
    ensureOpened,
    revealChatTerminal,
    onBranchCommand: handleBranchCommand,
  });
  const activeTerminalIdRef = useRef(activeTerminalId);
  activeTerminalIdRef.current = activeTerminalId;

  // ── Continue-after-error pill ────────────────────────────────────────
  // The transcript's last turn is a recoverable API error, so the session is
  // parked mid-response. The global watcher already nudges LIVE sessions it
  // saw stall (when auto-continue is on); the pill covers everything else —
  // a session that died while the app was closed, or one whose single
  // auto-retry is already spent. Suppressed while a retry is actually in
  // flight so we never show a button for work already happening.
  const stalledOnApiError = useMemo(
    () => retryableApiErrorAtEnd(session) != null,
    [session],
  );
  // A session limit is the one stuck-point the watcher never auto-retries (it
  // would just re-hit the limit until it resets), so it only ever surfaces as a
  // manual pill. The reset clause is display-only — the same "Please continue"
  // resumes the work once the window lifts.
  const sessionLimitReset = useMemo(() => {
    const at = sessionLimitAtEnd(session);
    return at ? { text: sessionLimitResetText(at) } : null;
  }, [session]);
  const continueInFlight = useAutoContinueInFlight(activeTerminalId);
  const [continueStarting, setContinueStarting] = useState(false);

  // Clicked while the chat was cold: boot `claude` first. A TUI that isn't up
  // yet drops the trailing Enter, so the send waits for the agent-live fact
  // rather than firing hopefully at the pty (see the composer's `notReady`).
  const handleContinue = useCallback(() => {
    if (!selectedSessionId) return;
    if (chatTerminalReady && agentLive) {
      sendChat(CONTINUE_TEXT);
      return;
    }
    void connectChat();
    setContinueStarting(true);
  }, [selectedSessionId, chatTerminalReady, agentLive, sendChat, connectChat]);

  useEffect(() => {
    if (!continueStarting) return;
    if (!chatTerminalReady || !agentLive || chatWorking || awaitingSelection)
      return;
    setContinueStarting(false);
    sendChat(CONTINUE_TEXT);
  }, [
    continueStarting,
    chatTerminalReady,
    agentLive,
    chatWorking,
    awaitingSelection,
    sendChat,
  ]);

  // A pending nudge belongs to the session it was clicked in, and is moot once
  // the session is no longer stalled (it recovered, or something else was sent).
  useEffect(() => setContinueStarting(false), [selectedSessionId]);
  useEffect(() => {
    if (!stalledOnApiError && !sessionLimitReset) setContinueStarting(false);
  }, [stalledOnApiError, sessionLimitReset]);

  // New chat: pre-pick the session uuid and start its engine in the background
  // — the composer goes live as soon as the driver is up; the transcript
  // appears with the first exchange. The start has to name the session
  // explicitly: it's brand new, so it isn't the selected one yet.
  const handleNewChat = useCallback(() => {
    const sid = crypto.randomUUID();
    markNewSession(sid);
    openChatTab(sid);
    void startChatFor(sid);
    setTab("chat");
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [startChatFor, openChatTab]);

  // Comments cleared by the last "Add to chat", kept so ⌘Z in the composer can
  // put them back exactly where they were (see handleUndoAddToChat).
  const addToChatUndoRef = useRef<ProjectAnnotations | null>(null);

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
      addToChatUndoRef.current = snapshotAndClearAll();
      requestAnimationFrame(() => {
        chatInputRef.current?.append(text);
        chatInputRef.current?.focus();
      });
    },
    [activeTab, tabs, setActive, handleNewChat, snapshotAndClearAll],
  );

  // The composer pulled the just-added text back out (⌘Z) — restore the
  // comments it was made from, so they reappear in the panel.
  const handleUndoAddToChat = useCallback(() => {
    const snap = addToChatUndoRef.current;
    if (!snap) return;
    addToChatUndoRef.current = null;
    restoreAll(snap);
  }, [restoreAll]);

  // "Clear" the comment buffer — discards every comment across files, diffs,
  // PRs, and chat. Gated behind a confirmation since it can't be undone.
  const handleClearComments = useCallback(async () => {
    const ok = await confirm({
      title: "Clear all comments?",
      description:
        "This permanently removes every comment you've added across files, diffs, PRs, and the chat. This can't be undone.",
      confirmLabel: "Clear comments",
    });
    if (!ok) return;
    clearAll();
  }, [confirm, clearAll]);

  // ⌘J's connect path: hook the selected chat up to Claude if it isn't already
  // AND reveal the dock — one action, no separate "Connect" step. The dock
  // opens only once the engine reports a terminal to put in it, so ⌘J never
  // flashes an empty pane (and does nothing at all for an engine that has no
  // terminal to show).
  const connectAndShowChat = useCallback(() => {
    void connectChat().then((shown) => {
      if (shown) setTerminalOpen(true);
    });
  }, [connectChat, setTerminalOpen]);

  const [runConfigOpen, setRunConfigOpen] = useState(false);
  const [buildConfigOpen, setBuildConfigOpen] = useState(false);

  // Build comes first, but only inside a worktree (that's where a per-branch
  // build makes sense); Run follows and is always present and non-closable.
  // Both pty ids are scoped to this worktree's encoded so the processes are
  // per-worktree; the command lists themselves are project-level (via props).
  const sidebarTerminals = useMemo(
    () => [
      ...(isWorktree
        ? [
            {
              id: `build:${project.encoded}`,
              label: "Build",
              kind: "build" as const,
            },
          ]
        : []),
      { id: `run:${project.encoded}`, label: "Run", kind: "run" as const },
      ...shells.map((id) => ({
        id,
        label: `Terminal ${shellNumber(id)}`,
        kind: "shell" as const,
      })),
    ],
    [project.encoded, isWorktree, shells, shellNumber],
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
      if (!activeRef.current) return;
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
      if (!activeRef.current) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        setTab("chat");
        if (!chatTerminalReady) void connectChat();
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chatTerminalReady, connectChat]);

  // ⌘⇧S opens (or focuses) the scratchpad tab.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "s"
      ) {
        e.preventDefault();
        openTab(makeScratchTab());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openTab]);

  // ⌘N starts a new chat in this project.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
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
      if (!activeRef.current) return;
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
      if (!activeRef.current) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "d")
        return;
      // Only file/diff tabs have a staging cycle; chat, scratch and PR don't.
      if (
        !activeTab ||
        activeTab.kind === "chat" ||
        activeTab.kind === "scratch" ||
        activeTab.kind === "pr"
      )
        return;
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
        // A file tab's path is project-relative (repo subPath prefixed).
        current = "file";
        projectRelPath = activeTab.path;
        const stages = fileStages(activeTab.path);
        if (!stages || (!stages.staged && !stages.unstaged)) {
          pushToast({ title: "No diff found for that file." }, 3_000);
          return;
        }
        subPath = stages.subPath;
        repoPath = stages.path;
        hasUnstaged = stages.unstaged;
        hasStaged = stages.staged;
      } else {
        subPath = activeTab.subPath;
        repoPath = activeTab.path;
        projectRelPath = subPath ? `${subPath}/${repoPath}` : repoPath;
        current = activeTab.staged ? "staged" : "unstaged";
        const stages = fileStages(projectRelPath);
        hasUnstaged = stages?.unstaged ?? false;
        hasStaged = stages?.staged ?? false;
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
  }, [activeTab, fileStages, openTab]);

  // ⌘⇧O — the header control's action as a keystroke; `openTarget` keeps the
  // two aiming at the same thing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "o")
        return;
      const app = getDefaultExternalApp();
      if (!app) return;
      e.preventDefault();

      const { relPath, subPath } = openTarget(activeTab);
      void window.electronAPI
        .openInExternalApp(app.id, project.encoded, relPath, subPath)
        .then((r) => {
          if (!r.ok)
            pushToast({ title: r.error ?? "Could not open that app." }, 4_000);
        });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, project.encoded]);

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
      if (!activeRef.current) return;
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
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newShell();
      } else if (e.key === "Escape" && terminalOpen) {
        setTerminalOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    terminalOpen,
    setTerminalOpen,
    newShell,
    selectedSessionId,
    chatTerminalReady,
    connectAndShowChat,
  ]);

  const tabSwitcher = useTabSwitcher({
    // Per-worktree id: under the keep-alive pool several workspaces are mounted
    // and each registers a Ctrl+Tab channel. A shared id would let the
    // switcher's `channels.find(c => c.id === active.id)` resolve to the wrong
    // (background) workspace on commit; a unique id keeps each self-contained.
    id: `tabs:${project.encoded}`,
    // Only the visible workspace listens for Ctrl+Tab (all mounted workspaces
    // share the global driver). Any non-empty list opens the overlay — even a
    // single entry (common in a fresh worktree: one chat, maybe already the
    // open tab). Requiring 2+ made Ctrl+Tab silently do nothing there, which
    // read as "worktrees don't have the switcher".
    enabled: active && switcherEntries.length > 0,
    triggerCode: "Tab",
    items: switcherEntries,
    currentIndex: switcherCurrentIndex,
    onCommit: (e) =>
      e.type === "tab" ? setActive(e.id) : openChatTab(e.sessionId),
  });

  return (
    <SidebarProvider
      defaultOpen={true}
      storageKey="plan.middleSidebar.open"
      // ⌘E toggles this sidebar via a global listener — only wire it for the
      // visible workspace so a background one doesn't also toggle.
      shortcut={active ? MIDDLE_SIDEBAR_SHORTCUT : undefined}
    >
      {confirmDialog}
      {pushDialog && (
        <PushModal
          preview={pushDialog.preview}
          repoLabel={
            repos.length > 1
              ? (syncTargets.find((t) => t.subPath === pushDialog.subPath)
                  ?.repoName ?? null)
              : null
          }
          onPush={() => handlePush(pushDialog.subPath)}
          onRefreshPreview={() =>
            window.electronAPI.pushPreview(project.encoded, pushDialog.subPath)
          }
          onClose={() => setPushDialog(null)}
        />
      )}
      {runConfigOpen && (
        <CommandsConfigModal
          title="Run"
          description="Shared across every worktree and session of this project."
          entries={runEntries}
          repos={repos}
          onSave={onSaveRun}
          onClose={() => setRunConfigOpen(false)}
        />
      )}
      {buildConfigOpen && (
        <CommandsConfigModal
          title="Build"
          description="Shared across every worktree and session of this project."
          entries={buildEntries}
          repos={repos}
          onSave={onSaveBuild}
          onClose={() => setBuildConfigOpen(false)}
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
          title="Tabs & chats"
          index={tabSwitcher.index}
          items={switcherEntries.map((e) => {
            if (e.type === "session") {
              return {
                key: e.id,
                label: e.title,
                sub: "Chat",
                divider: hasOpenTabs && e.id === firstSessionSwitcherId,
                dividerLabel: "Recent chats",
              };
            }
            const t = e.tab;
            return {
              key: e.id,
              label: titleForTab(t),
              sub:
                t.kind === "chat"
                  ? "Chat"
                  : t.kind === "scratch"
                    ? "Scratchpad"
                    : t.kind === "diff"
                      ? t.staged
                        ? "Diff · staged"
                        : "Diff"
                      : t.kind === "pr"
                        ? `PR #${t.number}`
                        : t.path,
            };
          })}
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
        <div
          className={cn(
            "content-card flex min-w-0 flex-1 flex-col",
            // Project sidebar collapsed → the card is flush to the window edge,
            // so drop its left divider (it'd otherwise be a stray line there).
            !projectsSidebarOpen && "content-card--flush-left",
          )}
        >
          <WorkspaceHeader
            project={project}
            projectsSidebarOpen={projectsSidebarOpen}
            branch={headerRepo?.branch ?? null}
            repoLabel={
              headerRepo && repos.length > 1
                ? repoDisplayName(headerRepo, project.cwd)
                : null
            }
            activeTab={activeTab}
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

                {/* Diff tabs — each pane is memoized (see DiffTabPane) so an
                    unrelated re-render doesn't touch every mounted diff. */}
                {tabs.map((t) =>
                  t.kind === "diff" && paneMounted(t.id) ? (
                    <DiffTabPane
                      key={t.id}
                      tab={t}
                      active={active && t.id === activeId}
                      encoded={project.encoded}
                      diff={getFileDiff(t.subPath, t.path)}
                      onStageFile={handleStageFile}
                      onUnstageFile={handleUnstageFile}
                      onDiscardFile={handleDiscardFile}
                      onChanged={refreshDiff}
                      confirm={confirm}
                    />
                  ) : null,
                )}

                {/* File tabs */}
                {tabs.map((t) =>
                  t.kind === "file" && paneMounted(t.id) ? (
                    <FileTabPane
                      key={t.id}
                      tab={t}
                      active={active && t.id === activeId}
                      encoded={project.encoded}
                      annotations={
                        annotationsByProjectFile[t.path] ?? EMPTY_ANN
                      }
                      revealTarget={
                        fileReveal && fileReveal.path === t.path
                          ? fileReveal
                          : null
                      }
                      onAddAnnotation={addProjectFileAnnotation}
                      onUpdateAnnotation={updateProjectFileAnnotation}
                      onRemoveAnnotation={removeProjectFileAnnotation}
                    />
                  ) : null,
                )}

                {/* Scratchpad — a per-worktree singleton tab. Kept mounted (like
                    the others) so its undo history and cursor survive switching
                    away and back. */}
                {tabs.map((t) =>
                  t.kind === "scratch" && paneMounted(t.id) ? (
                    <div
                      key={t.id}
                      className={cn(
                        "absolute inset-0 min-h-0",
                        t.id !== activeId && "hidden",
                      )}
                    >
                      <ScratchEditor
                        encoded={project.encoded}
                        active={active && t.id === activeId}
                      />
                    </div>
                  ) : null,
                )}

                {/* PR tabs — each mounted, hidden when inactive so sub-tab and
                    scroll state survive switching. */}
                {tabs.map((t) =>
                  t.kind === "pr" && paneMounted(t.id) ? (
                    <div
                      key={t.id}
                      className={cn(
                        "absolute inset-0",
                        t.id !== activeId && "hidden",
                      )}
                    >
                      <PrView
                        encoded={project.encoded}
                        subPath={t.subPath}
                        number={t.number}
                        active={active && t.id === activeId}
                      />
                    </div>
                  ) : null,
                )}

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
                            {!awaitingSelection && agentLive && chatWorking ? (
                              <TextShimmer duration={2.4}>Working</TextShimmer>
                            ) : (
                              <span>
                                {awaitingSelection
                                  ? "Needs input"
                                  : !agentLive
                                    ? "Terminal"
                                    : "Claude"}
                              </span>
                            )}
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
                      if (t.kind !== "chat" || !paneMounted(t.id)) return null;
                      // Active only when this workspace is the visible one AND
                      // this is its active tab — so a hidden (keep-alive) chat
                      // stops driving its terminal/working signals.
                      const tabActive = active && t.id === activeId;
                      // Active-only signals (working/terminalReady) are passed as
                      // `false` to inactive panes, so a working-state flip on the
                      // live chat re-renders only that one transcript — not all.
                      return (
                        <ChatTabPane
                          key={t.id}
                          tab={t}
                          active={tabActive}
                          encoded={project.encoded}
                          transcript={transcripts.get(t.sessionId)}
                          annotations={chatAnnotations}
                          working={tabActive ? chatWorking : false}
                          terminalReady={tabActive ? chatTerminalReady : false}
                          isNew={isNewSession(t.sessionId)}
                          onAddAnnotation={addChatAnnotation}
                          onUpdateAnnotation={updateChatAnnotation}
                          onRemoveAnnotation={removeChatAnnotation}
                          onSendKeys={sendKeysToChat}
                        />
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
                          shortcutEnabled={active && activeTab?.kind === "chat"}
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
                      onStart={connectChat}
                      onSend={sendChat}
                      blocked={awaitingSelection}
                      onBlocked={() => revealChatTerminal(selectedSessionId)}
                      autoFocus={isNewSession(selectedSessionId)}
                      onAddToChatUndo={handleUndoAddToChat}
                      commentsPending={totalComments > 0}
                      canContinue={
                        stalledOnApiError && !chatWorking && !continueInFlight
                      }
                      atSessionLimit={!!sessionLimitReset && !chatWorking}
                      sessionLimitReset={sessionLimitReset?.text ?? null}
                      continueStarting={continueStarting}
                      onContinue={handleContinue}
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
                    const termActive = tid === activeTerminalId;
                    return (
                      <div
                        key={tid}
                        className={cn(
                          "absolute inset-0 overflow-hidden",
                          !termActive && "hidden",
                        )}
                      >
                        <TerminalPanel
                          id={tid}
                          encoded={project.encoded}
                          label={
                            tid.startsWith(chatPrefix) ? "Claude" : "Terminal"
                          }
                          // No initial command: a chat pane attaches to a pty
                          // its engine already started (and already ran Claude
                          // in). See main/agents/cli-engine.
                          // Also gated on the workspace being visible so a
                          // background (keep-alive) terminal buffers its pty
                          // output instead of parsing it on the main thread.
                          visible={active && terminalOpen && termActive}
                          fitSignal={terminalHeight}
                          onClose={() => setTerminalOpen(false)}
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
          onPush={openPushDialog}
          onCommit={handleCommit}
          filesLoading={filesLoading}
          diffAvailable={repos.length > 0}
          sessions={sessions}
          selectedSession={openKind === "chat" ? selectedSessionId : null}
          onSelectSession={handleSelectSession}
          onSetSessionArchived={handleSetSessionArchived}
          onRenameSession={handleRenameRequest}
          onMoveSession={onMoveSession}
          onNewChat={handleNewChat}
          sessionsLoading={sessionsLoading}
          projectFiles={projectFiles}
          projectFilesLoading={projectFilesLoading}
          selectedProjectFile={
            openKind === "files" ? selectedProjectFile : null
          }
          onSelectProjectFile={handleSelectProjectFile}
          onOpenSearchResult={handleOpenSearchResult}
          activePr={activePr}
          onOpenPr={handleOpenPr}
          repoName={prRepoName}
          encoded={project.encoded}
          terminals={sidebarTerminals}
          // Default to the always-present Run tab when no shell is selected.
          activeTerminalId={activeShellId ?? `run:${project.encoded}`}
          onNewTerminal={newShell}
          onSelectTerminal={selectShell}
          onCloseTerminal={closeShell}
          runEntries={runEntries}
          buildEntries={buildEntries}
          onConfigureRun={() => setRunConfigOpen(true)}
          onConfigureBuild={() => setBuildConfigOpen(true)}
          onOpenScratch={() => openTab(makeScratchTab())}
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

/**
 * Memoized so a `Shell` re-render (a watcher tick, a modal toggle, a switch to
 * ANOTHER workspace) doesn't re-render every keep-alive-mounted workspace — only
 * the ones whose props actually changed. Under the keep-alive pool several are
 * mounted at once, so this is what keeps a switch from re-rendering all of them;
 * it relies on `Shell` passing stable prop identities (see App.tsx).
 */
export const ProjectWorkspace = memo(ProjectWorkspaceImpl);
