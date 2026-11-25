import type { SwipeGestureEvent } from "@/common/shared-types";
import type { NavDirection } from "./nav-history";

/** Horizontal travel (points) past which lifting the fingers navigates. */
export const SWIPE_COMMIT_DISTANCE = 120;
/** Travel (points) before the gesture's axis is decided. */
const AXIS_DECISION_DISTANCE = 8;

export interface SwipeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What sits under the pointer when the gesture begins. Scrollability is
 *  captured at begin, before Chromium has applied any of this gesture. */
export interface SwipeTarget {
  rect: SwipeRect;
  canScroll: Record<NavDirection, boolean>;
}

export interface SwipeEnv {
  /** The swipe zone under (x, y), or null when the point is outside it. */
  targetAt(x: number, y: number): SwipeTarget | null;
  canNavigate(direction: NavDirection): boolean;
}

export type SwipeState =
  | { kind: "idle" }
  | { kind: "ignored" }
  | { kind: "deciding"; target: SwipeTarget; sumX: number; sumY: number }
  | {
      kind: "tracking";
      target: SwipeTarget;
      direction: NavDirection;
      sumX: number;
    };

export const IDLE: SwipeState = { kind: "idle" };

export function swipeProgress(state: SwipeState): number {
  if (state.kind !== "tracking") return 0;
  const travel = state.direction === "back" ? -state.sumX : state.sumX;
  return Math.min(1, Math.max(0, travel / SWIPE_COMMIT_DISTANCE));
}

function accumulate(
  state: SwipeState,
  dx: number,
  dy: number,
  env: SwipeEnv,
): SwipeState {
  if (state.kind === "tracking") return { ...state, sumX: state.sumX + dx };
  if (state.kind !== "deciding") return state;
  const sumX = state.sumX + dx;
  const sumY = state.sumY + dy;
  if (Math.hypot(sumX, sumY) < AXIS_DECISION_DISTANCE)
    return { ...state, sumX, sumY };
  if (Math.abs(sumY) >= Math.abs(sumX)) return { kind: "ignored" };
  const direction: NavDirection = sumX < 0 ? "back" : "forward";
  if (state.target.canScroll[direction] || !env.canNavigate(direction))
    return { kind: "ignored" };
  return { kind: "tracking", target: state.target, direction, sumX };
}

/** Advance the gesture by one event. `commit` is set on the finger lift that
 *  completes a swipe past the commit distance. */
export function stepSwipe(
  state: SwipeState,
  event: SwipeGestureEvent,
  env: SwipeEnv,
): { state: SwipeState; commit?: NavDirection } {
  switch (event.phase) {
    case "begin": {
      const target = env.targetAt(event.x, event.y);
      if (!target) return { state: { kind: "ignored" } };
      return {
        state: accumulate(
          { kind: "deciding", target, sumX: 0, sumY: 0 },
          event.dx,
          event.dy,
          env,
        ),
      };
    }
    case "update":
      return { state: accumulate(state, event.dx, event.dy, env) };
    case "end":
      return state.kind === "tracking" && swipeProgress(state) >= 1
        ? { state: IDLE, commit: state.direction }
        : { state: IDLE };
    case "cancel":
      return { state: IDLE };
  }
}
