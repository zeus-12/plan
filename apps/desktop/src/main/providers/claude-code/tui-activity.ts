import { isTerminalRunning, terminalPid, terminalScreen } from "../../terminal";
import { agentProcessFor } from "./agent-process";
import { classifyInputState, screenIsBusy } from "./tui-screen";
import type { ChatActivity } from "../../../chat-engines";

/**
 * Reading Claude Code's TUI: turning a rendered screen into the two facts the
 * app cares about — a turn is in flight, and Claude is waiting on you.
 *
 * Event-driven, not polled. The renderer used to poll on fixed intervals, which
 * meant a full screen scan of every pty several times a second even at idle. A
 * state change can only follow OUTPUT (the working hint appearing or
 * disappearing, and a menu being drawn or cleared, are both repaints), so each
 * output burst schedules one trailing evaluation of THAT chat and only a
 * changed result is emitted. Idle chats cost nothing.
 */

// Trailing delay after an output burst. Output flows continuously while Claude
// works, and the timer is only armed when none is pending, so a steady stream
// evaluates every 250ms and the final repaint after the stream stops gets its
// own evaluation. Also comfortably after the emulator has parsed the burst.
const EVAL_DELAY_MS = 250;

interface Tracked {
  timer: ReturnType<typeof setTimeout> | null;
  /** Supersede marker: only the newest in-flight evaluation may emit. */
  gen: number;
  /** Last activity emitted — a repeat of the same pair is not an event. */
  last: ChatActivity;
}

const IDLE: ChatActivity = { busy: false, awaitingApproval: false };

/**
 * Whether a live agent process is running under this pty. A menu detected in a
 * dead shell's scrollback isn't actionable, so "waiting on you" is gated on
 * this. Claude's CLI runs under node, so either name counts.
 */
export async function agentLiveIn(id: string): Promise<boolean> {
  const pid = terminalPid(id);
  if (pid == null) return false;
  try {
    return /claude|node/i.test((await agentProcessFor(pid)) ?? "");
  } catch {
    return false;
  }
}

/** Is a turn in flight — Claude's "esc to interrupt" hint is on screen. */
export function isBusy(id: string): boolean {
  return screenIsBusy(terminalScreen(id));
}

/** Is a selection/approval menu drawn (regardless of whether an agent is live). */
export function hasMenu(id: string): boolean {
  return classifyInputState(terminalScreen(id)).state === "selection";
}

/** Is Claude really parked waiting on the user: a menu AND a live agent. */
export async function isAwaitingApproval(id: string): Promise<boolean> {
  return hasMenu(id) && (await agentLiveIn(id));
}

/**
 * Ids among `ids` that are parked waiting on the user. Batched because the
 * sidebar and the approval notifier ask about the whole fleet at once —
 * including chats in projects and worktrees that aren't on screen, which is the
 * entire point of those surfaces.
 */
export async function awaitingApprovalIds(ids: string[]): Promise<string[]> {
  const candidates = ids.filter(hasMenu);
  // No menu anywhere — skip the (TTL-cached, but not free) process-tree scan.
  if (candidates.length === 0) return [];
  const live = await Promise.all(candidates.map(agentLiveIn));
  return candidates.filter((_, i) => live[i]);
}

export interface ActivityTracker {
  /** A chat's pty emitted output — schedule an evaluation. */
  noteOutput(id: string): void;
  /** Re-key in place, following a pty that moved to a new session id. */
  rename(oldId: string, newId: string): void;
  /** The chat ended; drop its pending evaluation and state. */
  forget(id: string): void;
  dispose(): void;
}

/**
 * Track activity for chats, calling `onChange` only when a chat's pair of facts
 * actually flips.
 */
export function createActivityTracker(
  onChange: (id: string, activity: ChatActivity) => void,
): ActivityTracker {
  const tracked = new Map<string, Tracked>();

  const evaluate = async (id: string) => {
    const t = tracked.get(id);
    if (!t || !isTerminalRunning(id)) return;
    const gen = ++t.gen;
    const rows = terminalScreen(id);
    const busy = screenIsBusy(rows);
    const menu = classifyInputState(rows).state === "selection";
    const awaitingApproval = menu ? await agentLiveIn(id) : false;
    // A newer evaluation started while we awaited ps — let it do the emitting.
    if (t.gen !== gen || tracked.get(id) !== t) return;
    if (t.last.busy === busy && t.last.awaitingApproval === awaitingApproval)
      return;
    t.last = { busy, awaitingApproval };
    onChange(id, t.last);
  };

  return {
    noteOutput(id) {
      let t = tracked.get(id);
      if (!t) {
        // A fresh shell is idle with no menu; only transitions are emitted.
        t = { timer: null, gen: 0, last: IDLE };
        tracked.set(id, t);
      }
      if (t.timer) return;
      t.timer = setTimeout(() => {
        t.timer = null;
        void evaluate(id);
      }, EVAL_DELAY_MS);
    },

    rename(oldId, newId) {
      const t = tracked.get(oldId);
      if (!t) return;
      tracked.delete(oldId);
      // The pending evaluation is keyed by the OLD id and would find nothing;
      // drop it and let the next output burst re-arm under the new one.
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.gen++;
      tracked.set(newId, t);
    },

    forget(id) {
      const t = tracked.get(id);
      if (!t) return;
      if (t.timer) clearTimeout(t.timer);
      tracked.delete(id);
    },

    dispose() {
      for (const t of tracked.values()) if (t.timer) clearTimeout(t.timer);
      tracked.clear();
    },
  };
}
