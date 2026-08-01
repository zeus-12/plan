import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import {
  listProjectEncodeds,
  resolveProjectCwd,
  primeProjectCwd,
  moveSessionTranscript,
} from "./providers/claude-code/projects";
import {
  latestActivity,
  listSessions,
  sessionFilePath,
} from "./providers/claude-code/sessions";
import { pathExists } from "@/main/fs/fs-util";
import { resolveWorkspaceCwd } from "@/main/worktrees/workspace";
import { encodeCwd } from "./providers/claude-code/encoding";
import {
  getManualCwds,
  addManualCwd,
  getArchivedEncoded,
  setArchived,
  getArchivedSessions,
  setSessionArchived,
  getSessionNames,
  setSessionName,
} from "@/main/store/manual-projects";
import {
  readClaudeConfig,
  writeClaudeConfig,
} from "./providers/claude-code/instructions";
import { readScratch, writeScratch } from "@/main/store/scratch-store";
import {
  listExternalApps,
  openInExternalApp,
  resolveTargetPath,
} from "@/main/app/external-apps";
import type {
  ProjectEntry,
  SessionEvent,
  SessionListEntry,
  SwitcherForwardedCode,
} from "@/common/shared-types";
import type {
  IpcEventContract,
  IpcInvokeContract,
  IpcSendContract,
} from "@/common/ipc-contract";
import { chatTerminalId, isChatTerminalId } from "@/common/terminal-ids";
import {
  setCallbacks,
  startWatching,
  startRootWatch,
  stopAll,
} from "./providers/claude-code/watcher";
import {
  setWorktreeCallbacks,
  startWorktreeWatch,
  stopWorktreeWatch,
  stopAllWorktreeWatches,
} from "@/main/worktrees/worktree-watcher";
import { readSessionDelta } from "./providers/claude-code/transcript";
import { markSessionMovedAway } from "./providers/claude-code/reaper";
import { getFileContents, getFileView } from "@/main/fs/file-contents";
import {
  listPrs,
  getPrMeta,
  getPrConversation,
  getPrDiff,
  getPrHeadSha,
  getPrFileView,
} from "@/main/git/github";
import { getFileImageDiff } from "@/main/fs/file-media";
import {
  invalidateFileList,
  listProjectFiles,
  readProjectFile,
  resolveProjectFilePath,
  searchProjectFiles,
} from "@/main/fs/project-files";
import { listSkills } from "./providers/claude-code/skills";
import { getProjectIcons } from "@/main/fs/project-icons";
import { checkForUpdate } from "@/main/app/updates";
import { loginShellPath } from "@/main/terminal/shell-env";
import {
  addTerminalListener,
  openTerminal,
  writeTerminal,
  isTerminalRunning,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  listTerminals,
} from "@/main/terminal/terminal";
import {
  approvalChatIds,
  busyChatIds,
  chatEngineDescriptors,
  chatStatus,
  listenToChats,
  probeChatApproval,
  rekeyChat,
  sendKeysToChat,
  sendToChat,
  startChat,
  stopAllChats,
  stopChat,
  stopChatAndWait,
} from "./providers/registry";
import {
  applyPatch,
  commit as gitCommit,
  discardAll,
  discardFile,
  discoverRepos,
  remoteBranchesByRepo,
  getBranch,
  getStatus,
  getWorkingTreeDiff,
  invalidateRepoLayout,
  push as gitPush,
  pushPreview as gitPushPreview,
  stageAll,
  stageFile,
  stashAll,
  unstageAll,
  unstageFile,
} from "@/main/git/git";
import {
  blameContents,
  blameRev,
  getCommitDetails,
  isCommitUrl,
} from "@/main/git/git-blame";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  listAllWorktrees,
  createWorktreePr,
  addReposToWorktree,
} from "@/main/worktrees/worktrees";
import {
  getProjectDefaults,
  setProjectDefaults,
  getWorktreeRecord,
} from "@/main/worktrees/worktrees-store";

const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;

/** Typed main→renderer push — the channel and payload are checked against
 *  IpcEventContract, the same contract the preload subscriptions derive from. */
function sendToRenderer<K extends keyof IpcEventContract>(
  channel: K,
  ...args: IpcEventContract[K]
) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}

// ── Menu ───────────────────────────────────────────────────────────

// Which modifiers arm each forwarded switcher trigger. Keyed by the shared
// SWITCHER_FORWARDED_CODES union, so forwarding a new code here without the
// renderer knowing (or vice versa) is a compile error, not a silent
// double-step. Tab stays Ctrl-only because Cmd+Tab is the macOS app switcher
// and must not be hijacked; Backquote accepts Ctrl or Cmd because Cmd+` is the
// key macOS users reach for, and overriding the OS "cycle windows" shortcut is
// harmless in a single-window app.
const switcherModifierOk: Record<
  SwitcherForwardedCode,
  (input: Electron.Input) => boolean
> = {
  Tab: (input) => input.control && !input.meta,
  Backquote: (input) => input.control || input.meta,
};

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        // Custom Reload (not role: "reload") so ⌘R doesn't reload directly: the
        // accelerator forwards to the renderer, which force-refreshes a data
        // page (PR view) if one claims it, else does the ordinary full reload.
        // A menu accelerator is the reliable, focus-independent path — and it
        // consumes the key, so we avoid preventDefault in before-input-event
        // (which swallows subsequent keyUps on macOS).
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => sendToRenderer("app:reload-request"),
        },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Window ─────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#fafafa",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Transcript images are shown via <img src="file://…"> from their local
      // path. In dev the renderer is served over http, whose origin blocks
      // file:// subresources — so relax webSecurity in dev only. Production
      // loads the renderer from file:// and is unaffected (stays secure).
      webSecurity: app.isPackaged,
    },
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Markdown links (target=_blank) open in the user's real browser, not a
  // blank Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Ctrl+Tab (sessions) / Ctrl+` (projects) switcher; Shift reverses direction.
  // Chromium swallows plain Ctrl+Tab before the page's keydown sees it, and a
  // macOS menu accelerator for Tab is unreliable (often consumed by AppKit
  // without firing). before-input-event is the dependable interception point:
  // it fires before the page, so we forward a cycle to the renderer, which owns
  // the modal and commits when the user releases Ctrl.
  //
  // We deliberately do NOT use globalShortcut here: a global hotkey fires once
  // per physical press and never repeats, so holding the key couldn't cycle.
  // before-input-event receives the OS key-repeat stream (repeated keyDowns
  // while held) — so holding the trigger auto-cycles, and it stops the instant
  // the key is released.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const modifierOk = Object.hasOwn(switcherModifierOk, input.code)
      ? switcherModifierOk[input.code as SwitcherForwardedCode]
      : undefined;
    if (modifierOk?.(input)) {
      // Do NOT event.preventDefault() here. On macOS, preventing this keyDown
      // stops Chromium from delivering ANY subsequent keyUps to the app — main
      // and renderer alike — including the Control release that commits the
      // switcher, which then hangs open (observed empirically; keyDowns kept
      // arriving while every keyUp vanished). Forward-only is safe: the
      // renderer preventDefaults these combos in its capture-phase keydown and
      // cycles ONLY from this forward (never from the native keydown — see
      // SWITCHER_FORWARDED_CODES usage in use-tab-switcher.ts), so a keystroke
      // that reaches both paths still steps exactly once.
      sendToRenderer("switcher:cycle", { key: input.code, shift: input.shift });
    }
  });

  mainWindow = win;
  return win;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Session listing ────────────────────────────────────────────────

/**
 * claude-sessions gives the fs-only entries; the archived flag and the
 * user-assigned name live in the manual-projects store, layered on here —
 * same split as RawSessionListEntry/SessionListEntry.
 */
async function listSessionsForProject(
  encoded: string,
): Promise<SessionListEntry[]> {
  const [entries, archivedIds, names] = await Promise.all([
    listSessions(encoded),
    getArchivedSessions(),
    getSessionNames(),
  ]);
  const archived = new Set(archivedIds);
  return entries.map((e) => ({
    ...e,
    archived: archived.has(e.sessionId),
    // A user-assigned name wins over the derived title.
    title: names[e.sessionId] ?? e.derivedTitle,
  }));
}

/**
 * Preserve a worktree's chats before the worktree itself is deleted: relocate
 * every transcript into the parent project's live working copy and archive it
 * there. Without this the transcripts would be orphaned under an encoded dir
 * that no longer maps to any worktree — recoverable in theory, invisible in
 * practice. Landing them in the project's archived-sessions list keeps a
 * finished worktree's conversations resumable from the main project. Each move
 * mirrors "session:move": kill the source `claude` and wait for exit, rename the
 * transcript, then arm the ghost reaper (a dying claude may re-flush a
 * message-less stub at the old path). A no-op when a worktree shares the
 * project's encoded, which can't normally happen.
 */
async function archiveWorktreeChatsToProject(
  worktreeEncoded: string,
  projectEncoded: string,
): Promise<void> {
  if (worktreeEncoded === projectEncoded) return;
  const sessions = await listSessions(worktreeEncoded);
  for (const s of sessions) {
    await stopChatAndWait(chatTerminalId(worktreeEncoded, s.sessionId));
    await moveSessionTranscript(s.sessionId, worktreeEncoded, projectEncoded);
    markSessionMovedAway(worktreeEncoded, s.sessionId);
    await setSessionArchived(s.sessionId, true);
  }
}

// ── IPC ─────────────────────────────────────────────────────────────

// Only manually-added projects are shown (persisted in plan-desktop.json), so
// the sidebar starts empty and the user curates it via "Add project". Sessions
// for each still come from ~/.claude/projects/<encoded>. `mtimeMs` is the
// latest session activity so the sidebar can sort most-recent-first.
async function listAllProjects(): Promise<ProjectEntry[]> {
  const [manualCwds, archivedEncoded] = await Promise.all([
    getManualCwds(),
    getArchivedEncoded(),
  ]);
  const archived = new Set(archivedEncoded);
  return Promise.all(
    manualCwds.map(async (cwd) => {
      const encoded = encodeCwd(cwd);
      // A manually-added project's cwd is the exact folder the user picked —
      // it's authoritative. Seed the cache with it so resolveProjectCwd hands
      // back this root rather than re-deriving a path from the newest session
      // JSONL (which can land on an inner subfolder when the project root has
      // no session of its own, or when the lossy encoding shares a bucket).
      primeProjectCwd(encoded, cwd);
      return {
        encoded,
        cwd,
        mtimeMs: await latestActivity(encoded),
        archived: archived.has(encoded),
      };
    }),
  );
}

// Every invoke channel's handler, keyed and typed by the contract: a missing
// or mistyped entry — or one whose result disagrees with what the renderer
// will see — is a compile error, not a runtime surprise.
const invokeHandlers: {
  [K in keyof IpcInvokeContract]: (
    event: Electron.IpcMainInvokeEvent,
    ...args: IpcInvokeContract[K]["args"]
  ) => IpcInvokeContract[K]["result"] | Promise<IpcInvokeContract[K]["result"]>;
} = {
  "projects:list": () => listAllProjects(),
  "projects:icons": (_e, encodeds) => getProjectIcons(encodeds),

  "projects:addManual": async (event) => {
    const win =
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const res = await dialog.showOpenDialog(
      win ?? new BrowserWindow({ show: false }),
      {
        title: "Add project",
        properties: ["openDirectory", "createDirectory"],
      },
    );
    if (res.canceled || res.filePaths.length === 0) return null;
    const cwd = res.filePaths[0];
    await addManualCwd(cwd);
    return { encoded: encodeCwd(cwd), cwd, mtimeMs: 0, archived: false };
  },

  "projects:setArchived": async (_e, encoded, archived) => {
    await setArchived(encoded, archived);
    return { ok: true };
  },
  "projects:listSessions": (_e, encoded) => listSessionsForProject(encoded),
  "sessions:setArchived": async (_e, sessionId, archived) => {
    await setSessionArchived(sessionId, archived);
    return { ok: true };
  },
  "sessions:rename": async (_e, sessionId, name) => {
    await setSessionName(sessionId, name);
    return { ok: true };
  },

  "session:move": async (_e, sessionId, fromEncoded, toEncoded) => {
    // Kill the source chat's `claude` and WAIT for it to exit before moving the
    // transcript — a live `claude` writes to a path derived from its cwd, so
    // the sooner it's gone the smaller the ghost window. But the kill can't be
    // a guarantee: claude runs under the pty's shell (SIGHUP doesn't reliably
    // reap it) and may flush one last state snapshot after the rename, leaving
    // a message-less stub at the old path. markSessionMovedAway arms the
    // deterministic reaper that neutralizes that ghost (see session-reaper).
    await stopChatAndWait(chatTerminalId(fromEncoded, sessionId));
    await moveSessionTranscript(sessionId, fromEncoded, toEncoded);
    if (fromEncoded !== toEncoded) markSessionMovedAway(fromEncoded, sessionId);
  },

  "session:read": async (_e, encoded, sessionId, client) => {
    try {
      return await readSessionDelta(
        sessionFilePath(encoded, sessionId),
        client,
      );
    } catch {
      return null;
    }
  },

  "project:diff": async (_e, encoded, subPath = "") =>
    getWorkingTreeDiff(await resolveWorkspaceCwd(encoded, subPath)),
  "project:fileContents": (_e, encoded, oldPath, newPath, subPath = "") =>
    getFileContents(encoded, oldPath, newPath, subPath),
  "project:fileView": (_e, encoded, path, mode, subPath = "") =>
    getFileView(encoded, path, mode, subPath),
  "project:fileImageDiff": (_e, encoded, path, mode, subPath = "") =>
    getFileImageDiff(encoded, path, mode, subPath),

  "github:listPrs": (_e, encoded, subPath = "") => listPrs(encoded, subPath),
  "github:prMeta": (_e, encoded, subPath, number) =>
    getPrMeta(encoded, subPath, number),
  "github:prConversation": (_e, encoded, subPath, number) =>
    getPrConversation(encoded, subPath, number),
  "github:prDiff": (_e, encoded, subPath, number) =>
    getPrDiff(encoded, subPath, number),
  "github:prHeadSha": (_e, encoded, subPath, number) =>
    getPrHeadSha(encoded, subPath, number),
  "github:prFileView": (_e, encoded, subPath, headSha, newPath) =>
    getPrFileView(encoded, subPath, headSha, newPath),

  "files:list": (_e, encoded) => listProjectFiles(encoded),
  "files:read": (_e, encoded, relPath) => readProjectFile(encoded, relPath),
  "files:path": (_e, encoded, relPath) =>
    resolveProjectFilePath(encoded, relPath),
  "files:search": async (_e, encoded, query, opts) => {
    // Never let an unexpected throw reject the IPC (which surfaces as an
    // opaque "Search failed" in the UI) — return it as a structured error.
    try {
      return await searchProjectFiles(encoded, query, opts);
    } catch (err) {
      return {
        files: [],
        totalMatches: 0,
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  "skills:list": (_e, encoded) => listSkills(encoded),
  "claudeConfig:read": (_e, encoded) => readClaudeConfig(encoded),
  "claudeConfig:write": (_e, path, text) => writeClaudeConfig(path, text),

  "repos:list": (_e, encoded) => discoverRepos(encoded),
  "repos:branches": (_e, encoded) => remoteBranchesByRepo(encoded),

  // Worktrees
  "worktrees:list": (_e, encoded) => listWorktrees(encoded),
  "worktrees:listAll": () => listAllWorktrees(),
  "worktrees:create": (_e, encoded, input) => createWorktree(encoded, input),
  "worktrees:remove": async (_e, id) => {
    // Save the worktree's chats into the parent project's archive before the
    // checkout is torn down — a deleted worktree should lose its code, not its
    // conversations.
    const rec = await getWorktreeRecord(id);
    if (rec)
      await archiveWorktreeChatsToProject(rec.encoded, rec.projectEncoded);
    await removeWorktree(id);
  },
  "worktrees:addRepos": (_e, id, input) => addReposToWorktree(id, input),
  "worktrees:createPr": (_e, id, input) => createWorktreePr(id, input),
  "worktrees:getDefaults": (_e, encoded) => getProjectDefaults(encoded),
  "worktrees:setDefaults": (_e, encoded, defaults) =>
    setProjectDefaults(encoded, defaults),

  // Worktree watching is scoped to whatever project workspace is mounted —
  // real repos are heavier to watch than the session JSONL dirs, so we only
  // watch the active one. The renderer calls these on mount/unmount.
  "worktree:watch": (_e, encoded) => {
    void startWorktreeWatch(encoded);
  },
  "worktree:unwatch": (_e, encoded) => {
    stopWorktreeWatch(encoded);
  },

  // Git
  "git:branch": (_e, encoded, subPath = "") => getBranch(encoded, subPath),
  "git:status": (_e, encoded, subPath = "") => getStatus(encoded, subPath),
  "git:stage": (_e, encoded, path, subPath = "") =>
    stageFile(encoded, path, subPath),
  "git:unstage": (_e, encoded, path, subPath = "") =>
    unstageFile(encoded, path, subPath),
  "git:discard": (_e, encoded, path, subPath = "") =>
    discardFile(encoded, path, subPath),
  "git:stageAll": (_e, encoded, subPath = "") => stageAll(encoded, subPath),
  "git:unstageAll": (_e, encoded, subPath = "") => unstageAll(encoded, subPath),
  "git:discardAll": (_e, encoded, subPath = "") => discardAll(encoded, subPath),
  "git:stashAll": (_e, encoded, subPath = "") => stashAll(encoded, subPath),
  "git:pushPreview": (_e, encoded, subPath = "") =>
    gitPushPreview(encoded, subPath),
  "git:push": (_e, encoded, subPath = "") => gitPush(encoded, subPath),
  "git:commit": (_e, encoded, message, subPath = "") =>
    gitCommit(encoded, message, subPath),
  "git:applyPatch": (_e, encoded, patch, mode, subPath = "") =>
    applyPatch(encoded, patch, { mode }, subPath),
  "git:blameContents": (_e, encoded, path, contents) =>
    blameContents(encoded, path, contents),
  "git:blameRev": (_e, encoded, path, rev) => blameRev(encoded, path, rev),
  "git:commitDetails": (_e, encoded, path, hash) =>
    getCommitDetails(encoded, path, hash),
  "git:openCommit": (_e, url) => {
    if (isCommitUrl(url)) void shell.openExternal(url);
  },

  // Chat engines (keyed by chat id) — see main/agents/engine-registry.
  "chat:engines": () => chatEngineDescriptors(),
  "chat:start": (_e, chatId, opts) => startChat(chatId, opts),
  "chat:status": (_e, chatId) => chatStatus(chatId),
  "chat:probeApproval": (_e, chatId) => probeChatApproval(chatId),
  "chat:busyIds": () => busyChatIds(),
  "chat:approvalIds": () => approvalChatIds(),
  "chat:rekey": (_e, oldChatId, newChatId) => rekeyChat(oldChatId, newChatId),

  // Terminal ptys (keyed by terminal id; cwd resolved from encoded)
  "terminal:open": (
    _e,
    id,
    encoded,
    cols,
    rows,
    initialCommand,
    subPath = "",
  ) =>
    openTerminal(id, encoded, cols, rows, initialCommand, subPath, {
      // A chat's pty belongs to its engine — a pane may only attach to one.
      // See the attachOnly note in terminal.ts for what spawning here would do.
      attachOnly: isChatTerminalId(id),
    }),
  "terminal:status": (_e, id) => ({ running: isTerminalRunning(id) }),
  "terminal:list": () => listTerminals(),

  // Write a pasted image to a temp file; the renderer types the path into the
  // terminal (Claude Code reads image paths as attachments).
  "terminal:saveTempImage": async (_e, data, ext) => {
    try {
      const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : "png";
      const file = join(tmpdir(), `plan-paste-${randomUUID()}.${safeExt}`);
      await writeFile(file, Buffer.from(data));
      return file;
    } catch {
      return null;
    }
  },

  // Does a path still exist on disk? Used to verify a restored draft's pasted
  // images are still present before showing/sending them (the OS can purge tmp).
  "terminal:fileExists": (_e, path) => pathExists(path),

  // Update notifier: report whether a newer release exists, and open the
  // download page in the user's browser. We never install — the app is unsigned.
  "updates:check": () => checkForUpdate(),
  "updates:openDownload": (_e, url) => {
    if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url);
  },

  // "Open in…": which apps are actually installed, and launching one on a
  // workspace path. See main/external-apps.ts — nothing here is guessed.
  "apps:list": () => listExternalApps(),
  "apps:open": (_e, appId, encoded, relPath, subPath) =>
    openInExternalApp(appId, encoded, relPath, subPath),
  "apps:resolvePath": (_e, encoded, relPath, subPath) =>
    resolveTargetPath(encoded, relPath, subPath),

  // Per-worktree scratchpad: durable notepad content persisted to ~/.plan.
  "scratch:read": (_e, encoded) => readScratch(encoded),
  "scratch:write": (_e, encoded, data) => writeScratch(encoded, data),
};

/** Fire-and-forget channels (`ipcMain.on`), same contract discipline. */
const sendHandlers: {
  [K in keyof IpcSendContract]: (
    event: Electron.IpcMainEvent,
    ...args: IpcSendContract[K]
  ) => void;
} = {
  "chat:send": (_e, chatId, text, imagePaths = []) =>
    sendToChat(chatId, text, imagePaths),
  "chat:sendKeys": (_e, chatId, keys) => sendKeysToChat(chatId, keys),
  "chat:stop": (_e, chatId) => stopChat(chatId),

  "terminal:input": (_e, id, data) => writeTerminal(id, data),
  "terminal:resize": (_e, id, cols, rows) => resizeTerminal(id, cols, rows),
  "terminal:kill": (_e, id) => killTerminal(id),
};

function registerIpc() {
  for (const channel of Object.keys(invokeHandlers) as Array<
    keyof IpcInvokeContract
  >) {
    ipcMain.handle(channel, invokeHandlers[channel]);
  }
  for (const channel of Object.keys(sendHandlers) as Array<
    keyof IpcSendContract
  >) {
    ipcMain.on(channel, sendHandlers[channel]);
  }
}

// ── Watcher → renderer bridge ──────────────────────────────────────

function bridgeWatcher() {
  const send = (e: SessionEvent) => sendToRenderer("watcher:event", e);
  setCallbacks({ onEvent: send });
  setWorktreeCallbacks({
    onEvent: (e) => {
      // The tree changed on disk, so per-project derived caches may be stale
      // (repo layout: git init / checkout dirs; file list: files added or
      // removed). At most one re-derivation per debounced watcher window
      // keeps them honest without heuristics.
      invalidateRepoLayout(e.encoded);
      invalidateFileList(e.encoded);
      send(e);
    },
  });
}

function bridgeTerminal() {
  // Pty-level: the terminal panes' byte stream, and the exit that keeps the
  // sidebar's shell list and the sessions dashboard honest.
  addTerminalListener({
    onData: (chunk) => sendToRenderer("terminal:data", chunk),
    onExit: (id) => sendToRenderer("terminal:exit", id),
  });
  // Chat-level: whichever engine drives a chat reports the same two facts.
  listenToChats({
    onActivity: (chatId, activity) =>
      sendToRenderer("chat:activity", chatId, activity),
    onExit: (chatId) => sendToRenderer("chat:exit", chatId),
  });
}

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  // A Finder-launched app gets launchd's stock PATH, which lacks Homebrew &
  // co. — adopt the login shell's PATH first, so every later spawn (gh, git,
  // ps) resolves the same binaries a terminal would. Null (unreadable shell)
  // keeps the inherited PATH.
  const loginPath = await loginShellPath();
  if (loginPath) process.env.PATH = loginPath;

  buildMenu();
  registerIpc();
  bridgeWatcher();
  bridgeTerminal();

  createMainWindow();

  // Seed the cwd cache from the authoritative manual-project paths before any
  // terminal:open / files:list IPC can arrive, so those never resolve a project
  // root from session history.
  await listAllProjects().catch(() => {});

  // Auto-watch every existing project, plus the root for new ones. Watcher
  // setup needs only the dir names — never the cwd resolution that used to
  // read every project's newest transcript here at boot.
  for (const encoded of await listProjectEncodeds()) {
    void startWatching(encoded);
  }
  void startRootWatch();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else focusMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) {
    stopAll();
    stopAllWorktreeWatches();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAll();
  stopAllWorktreeWatches();
  // Chats first: an engine may hold more than a pty (a protocol connection, a
  // child process of its own), and only it knows how to end its own sessions.
  stopAllChats();
  killAllTerminals();
});
