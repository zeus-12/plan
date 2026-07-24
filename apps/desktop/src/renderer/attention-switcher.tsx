import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { GitBranch } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import type { ProjectEntry, WorktreeRecord } from "../shared-types";
import { parseChatTerminalId } from "../terminal-ids";
import {
  currentApprovalIds,
  subscribeApproval,
} from "./lib/session-approval-store";
import {
  currentUnreadIds,
  subscribeUnread,
  getViewedId,
} from "./lib/unread-response-store";
import { getCachedSessions } from "./lib/session-cache";
import { pushToast } from "./lib/toast-store";

/**
 * Global "needs attention" palette — the whole feature lives in this one file
 * (detection + ordering + overlay + toast) so it can be removed by deleting the
 * file, its <AttentionSwitcher/> mount, and the one shortcuts-registry entry.
 *
 * Gesture: DOUBLE-TAP Control to open. Each further clean Control tap advances
 * the highlight (Shift+Control or ↑ reverses); PAUSE ~DWELL_COMMIT_MS and the
 * highlighted session is committed (Enter or click commit immediately; Esc,
 * click-outside, or window blur dismiss). Item 0 is the session you're on now
 * (whatever its status), and the highlight defaults to item 1 — alt-tab style.
 * When nothing else needs you, a toast says so instead of opening.
 *
 * A "tap" is Control pressed and released quickly with no NON-modifier key in
 * between, so Ctrl+Tab / Ctrl+C / holding Control as a modifier never trip it —
 * that's what keeps this from colliding with the hold-to-cycle switchers.
 *
 * Data comes from the two fleet-wide stores (approval = orange "waiting on you",
 * unread = green "replied"), both driven by verified TUI state — so every row is
 * a real "needs you" fact, never optimistic. Recency is tracked here as a
 * first-observed sequence, read via the stores' snapshot accessors.
 */

// ── Tuning (all in one place) ───────────────────────────────────────────────
const DOUBLE_TAP_MS = 400; // max gap between the two opening taps
const TAP_MAX_HOLD_MS = 450; // a longer Control hold is a modifier, not a tap
const DWELL_COMMIT_MS = 2000; // pause this long → commit the highlighted row
const TRIGGER_KEY = "Control";
const ORANGE = "#f59e0b"; // approval dot (matches approval-dot.tsx)
const GREEN = "#78b681"; // replied dot (matches replied-dot.tsx)

type Kind = "approval" | "unread" | "current";

export interface AttentionTarget {
  encoded: string;
  sessionId: string;
  projectEncoded: string;
  worktreeId: string | null;
}

interface Row extends AttentionTarget {
  /** The chat terminal id, used for dedup + recency lookup. */
  id: string;
  key: string;
  /** Primary line: the chat's title. */
  title: string;
  /** Side metadata: the parent project's name. */
  projectName: string;
  /** Side metadata: the worktree/branch name, or null for a working copy. */
  worktreeName: string | null;
  kind: Kind;
}

interface Config {
  resolve: (id: string, kind: Kind) => Row | null;
  navigate: (t: AttentionTarget) => void;
}

// ── Module state (single instance — one mount at app root) ───────────────────
let config: Config | null = null;
let session: { list: Row[]; index: number } | null = null;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

// Recency: first-observed order for every id currently in a store. Stamped as
// ids appear and pruned as they clear, so a re-parked session gets a newer
// stamp. Kept live by subscribing to both stores in install().
const seq = new Map<string, number>();
let seqCounter = 0;
function syncSeq() {
  const live = new Set([...currentApprovalIds(), ...currentUnreadIds()]);
  for (const id of live) if (!seq.has(id)) seq.set(id, ++seqCounter);
  for (const id of [...seq.keys()]) if (!live.has(id)) seq.delete(id);
}

// ── Dwell-to-commit timer ────────────────────────────────────────────────────
let dwellTimer: ReturnType<typeof setTimeout> | null = null;
function clearDwell() {
  if (dwellTimer) {
    clearTimeout(dwellTimer);
    dwellTimer = null;
  }
}
function startDwell() {
  clearDwell();
  dwellTimer = setTimeout(commitHighlighted, DWELL_COMMIT_MS);
}

function lastSegment(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// Orange (waiting on you), newest first, then green (replied), newest first —
// a session that's both is shown once, as orange.
function buildRows(resolve: (id: string, kind: Kind) => Row | null): Row[] {
  const stamp = (id: string) => seq.get(id) ?? 0;
  const orange = currentApprovalIds()
    .flatMap((id) => resolve(id, "approval") ?? [])
    .sort((a, b) => stamp(b.id) - stamp(a.id));
  const taken = new Set(orange.map((r) => r.id));
  const green = currentUnreadIds()
    .flatMap((id) => (taken.has(id) ? [] : (resolve(id, "unread") ?? [])))
    .sort((a, b) => stamp(b.id) - stamp(a.id));
  return [...orange, ...green];
}

function openPalette() {
  if (!config) return;
  syncSeq();
  const rows = buildRows(config.resolve);
  const viewed = getViewedId();
  const anchor = viewed ? config.resolve(viewed, "current") : null;
  // The current session is item 0; everything else follows. If there's nothing
  // else to switch to, there's no palette to show — just say so.
  const others = anchor ? rows.filter((r) => r.id !== anchor.id) : rows;
  if (others.length === 0) {
    pushToast({
      title: "You're all caught up",
      description: "No other sessions are waiting on you right now.",
    });
    return;
  }
  const list = anchor ? [anchor, ...others] : others;
  // Highlight the current tab (item 0) when we have one, so inaction returns you
  // there rather than committing a pending session you only meant to glance at.
  session = { list, index: 0 };
  emit();
  startDwell();
}

function closePalette() {
  clearDwell();
  if (session) {
    session = null;
    emit();
  }
}

function commitHighlighted() {
  const s = session;
  clearDwell();
  session = null;
  emit();
  if (s && config) {
    const row = s.list[s.index];
    if (row) config.navigate(row);
  }
}

function move(dir: 1 | -1) {
  if (!session) return;
  const n = session.list.length;
  session = { list: session.list, index: (session.index + dir + n) % n };
  emit();
  startDwell();
}

/** Mouse hover moves the highlight (and defers the dwell commit). */
export function attentionHover(i: number) {
  if (!session || session.index === i) return;
  session = { list: session.list, index: i };
  emit();
  startDwell();
}

/** Mouse click commits that row now. */
export function attentionSelect(i: number) {
  if (!session) return;
  session = { list: session.list, index: i };
  commitHighlighted();
}

/** Backdrop click dismisses without committing. */
export function attentionDismiss() {
  closePalette();
}

// ── Double-tap detection ─────────────────────────────────────────────────────
let ctrlDown = false;
let ctrlDownAt = 0;
let otherKeyDuringCtrl = false;
let lastTapAt = 0;

function onKeyDown(e: KeyboardEvent) {
  if (session) {
    // The palette owns the keyboard while open — capture + stopPropagation so a
    // focused list/terminal underneath doesn't also react.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commitHighlighted();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      move(-1);
      return;
    }
    // Anything else falls through so Control taps still advance.
  }
  if (e.key === TRIGGER_KEY) {
    if (!ctrlDown) {
      ctrlDown = true;
      ctrlDownAt = performance.now();
      otherKeyDuringCtrl = false;
    }
  } else if (e.key !== "Shift") {
    // A non-modifier key while Control is down means Control is being used as a
    // modifier, not tapped. Shift is exempt so Shift+Control can reverse.
    otherKeyDuringCtrl = true;
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key !== TRIGGER_KEY) return;
  const wasDown = ctrlDown;
  ctrlDown = false;
  if (!wasDown) return;
  const cleanTap =
    !otherKeyDuringCtrl && performance.now() - ctrlDownAt <= TAP_MAX_HOLD_MS;
  if (!cleanTap) {
    lastTapAt = 0;
    return;
  }
  if (session) {
    // Open: each tap traverses (Shift reverses); the dwell timer then commits.
    move(e.shiftKey ? -1 : 1);
    lastTapAt = 0;
    return;
  }
  const now = performance.now();
  if (now - lastTapAt <= DOUBLE_TAP_MS) {
    lastTapAt = 0;
    openPalette();
  } else {
    lastTapAt = now;
  }
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Losing focus mid-gesture: reset detection and don't leave the palette stuck.
  window.addEventListener("blur", () => {
    ctrlDown = false;
    lastTapAt = 0;
    closePalette();
  });
  // Keep recency live even while the palette is closed.
  subscribeApproval(syncSeq);
  subscribeUnread(syncSeq);
  syncSeq();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot() {
  return session;
}

function buildResolver(
  projects: ProjectEntry[],
  worktreesByProject: Map<string, WorktreeRecord[]>,
) {
  const projByEncoded = new Map(projects.map((p) => [p.encoded, p]));
  const wtByEncoded = new Map<
    string,
    { w: WorktreeRecord; project: ProjectEntry }
  >();
  for (const p of projects)
    for (const w of worktreesByProject.get(p.encoded) ?? [])
      wtByEncoded.set(w.encoded, { w, project: p });

  return (id: string, kind: Kind): Row | null => {
    const parsed = parseChatTerminalId(id);
    if (!parsed) return null;
    const { encoded, sessionId } = parsed;
    const proj = projByEncoded.get(encoded);
    const wt = wtByEncoded.get(encoded);
    let projectName: string;
    let worktreeName: string | null;
    let projectEncoded: string;
    let worktreeId: string | null;
    if (proj) {
      projectName = lastSegment(proj.cwd);
      worktreeName = null;
      projectEncoded = proj.encoded;
      worktreeId = null;
    } else if (wt) {
      projectName = lastSegment(wt.project.cwd);
      worktreeName = wt.w.name;
      projectEncoded = wt.project.encoded;
      worktreeId = wt.w.id;
    } else {
      // Not a live project/worktree (archived or removed) — can't navigate.
      return null;
    }
    // The chat title, when it's genuinely cached (worktrees visited this
    // launch); never fabricated. Falls back to a generic label otherwise — the
    // project/worktree metadata on the side still identifies the row.
    const title =
      getCachedSessions(encoded)?.find((s) => s.sessionId === sessionId)
        ?.title ?? "Chat";
    return {
      id,
      key: `${kind}:${id}`,
      encoded,
      sessionId,
      projectEncoded,
      worktreeId,
      title,
      projectName,
      worktreeName,
      kind,
    };
  };
}

interface Props {
  projects: ProjectEntry[];
  worktreesByProject: Map<string, WorktreeRecord[]>;
  onNavigate: (t: AttentionTarget) => void;
}

export function AttentionSwitcher({
  projects,
  worktreesByProject,
  onNavigate,
}: Props) {
  install();
  const resolve = useMemo(
    () => buildResolver(projects, worktreesByProject),
    [projects, worktreesByProject],
  );
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  useEffect(() => {
    config = { resolve, navigate: (t) => navRef.current(t) };
    return () => {
      if (config?.resolve === resolve) config = null;
    };
  }, [resolve]);

  const snap = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (!snap) return null;
  return <Overlay list={snap.list} index={snap.index} />;
}

function StatusDot({ kind, active }: { kind: Kind; active: boolean }) {
  if (kind === "current") {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: active ? "var(--bg)" : "var(--text-tertiary)",
          opacity: 0.5,
        }}
      />
    );
  }
  return (
    <span
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: kind === "approval" ? ORANGE : GREEN }}
    />
  );
}

function Overlay({ list, index }: { list: Row[]; index: number }) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attentionDismiss();
      }}
    >
      <div className="flex max-h-[70vh] w-[min(440px,80vw)] flex-col overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-2xl">
        <div className="shrink-0 border-b border-[var(--border)] px-4 py-2.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          Needs attention
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.map((row, i) => {
            const active = i === index;
            const prev = list[i - 1];
            const showDivider = i === 0 || prev?.kind !== row.kind;
            return (
              <div key={row.key}>
                {showDivider && (
                  <div className="my-1.5 flex items-center gap-2 px-1.5">
                    <span className="shrink-0 font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
                      {row.kind === "current"
                        ? "Current tab"
                        : row.kind === "approval"
                          ? "Waiting on you"
                          : "Replied"}
                    </span>
                    <div className="h-px flex-1 bg-[var(--border-strong)]" />
                  </div>
                )}
                <div
                  ref={active ? activeRef : undefined}
                  onMouseMove={() => attentionHover(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    attentionSelect(i);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
                    active ? "bg-[var(--accent)]" : "bg-transparent",
                  )}
                >
                  <StatusDot kind={row.kind} active={active} />
                  {/* Primary: the chat title, taking the space and truncating. */}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px]",
                      active ? "text-[var(--bg)]" : "text-[var(--text)]",
                    )}
                  >
                    {row.title}
                  </span>
                  {/* Side: parent project, then a branch chip if it's a worktree. */}
                  <span
                    className={cn(
                      "shrink-0 max-w-[45%] truncate font-[family-name:var(--font-mono)] text-[10px]",
                      active
                        ? "text-[var(--bg)] opacity-70"
                        : "text-[var(--text-tertiary)]",
                    )}
                  >
                    {row.projectName}
                  </span>
                  {row.worktreeName && (
                    <span
                      className={cn(
                        "flex shrink-0 max-w-[45%] items-center gap-1 rounded-full px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px]",
                        active
                          ? "text-[var(--bg)]"
                          : "text-[var(--text-secondary)]",
                      )}
                      style={{
                        backgroundColor: active
                          ? "color-mix(in srgb, var(--bg) 18%, transparent)"
                          : "var(--bg-surface)",
                      }}
                    >
                      <GitBranch className="size-2.5 shrink-0" />
                      <span className="truncate">{row.worktreeName}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-1.5 font-[family-name:var(--font-mono)] text-[9px] text-[var(--text-tertiary)]">
          tap ⌃ to move · pause to jump · stay on Current tab to return
        </div>
      </div>
    </div>
  );
}
