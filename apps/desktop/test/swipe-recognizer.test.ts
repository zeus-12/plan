import { describe, expect, it } from "vitest";
import type { SwipeGestureEvent } from "@/common/shared-types";
import {
  IDLE,
  SWIPE_COMMIT_DISTANCE,
  stepSwipe,
  swipeProgress,
  type SwipeEnv,
  type SwipeState,
  type SwipeTarget,
} from "@/renderer/features/navigation/swipe-recognizer";
import type { NavDirection } from "@/renderer/features/navigation/nav-history";

const target = (
  canScroll: Partial<Record<NavDirection, boolean>> = {},
): SwipeTarget => ({
  rect: { left: 0, top: 0, width: 800, height: 600 },
  canScroll: { back: false, forward: false, ...canScroll },
});

function env(over: Partial<SwipeEnv> = {}): SwipeEnv {
  return { targetAt: () => target(), canNavigate: () => true, ...over };
}

function run(events: SwipeGestureEvent[], e: SwipeEnv = env()) {
  let state: SwipeState = IDLE;
  const commits: NavDirection[] = [];
  for (const event of events) {
    const next = stepSwipe(state, event, e);
    state = next.state;
    if (next.commit) commits.push(next.commit);
  }
  return { state, commits };
}

const begin = (dx = 0, dy = 0): SwipeGestureEvent => ({
  phase: "begin",
  x: 10,
  y: 10,
  dx,
  dy,
});
const update = (dx: number, dy = 0): SwipeGestureEvent => ({
  phase: "update",
  dx,
  dy,
});
const end: SwipeGestureEvent = { phase: "end" };
const swipe = (dx: number, steps = 10) =>
  Array.from({ length: steps }, () => update(dx / steps));

describe("stepSwipe", () => {
  it("scrolling toward the left edge past the distance goes back on lift", () => {
    const { commits } = run([
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE - 10),
      end,
    ]);
    expect(commits).toEqual(["back"]);
  });

  it("scrolling toward the right edge goes forward", () => {
    const { commits } = run([
      begin(),
      ...swipe(SWIPE_COMMIT_DISTANCE + 10),
      end,
    ]);
    expect(commits).toEqual(["forward"]);
  });

  it("does not commit before the fingers lift", () => {
    const { state, commits } = run([
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE * 2),
    ]);
    expect(commits).toEqual([]);
    expect(swipeProgress(state)).toBe(1);
  });

  it("a short swipe does nothing", () => {
    expect(
      run([begin(), ...swipe(-SWIPE_COMMIT_DISTANCE / 2), end]).commits,
    ).toEqual([]);
  });

  it("reversing before lift cancels", () => {
    const { commits } = run([
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE - 10),
      ...swipe(SWIPE_COMMIT_DISTANCE),
      end,
    ]);
    expect(commits).toEqual([]);
  });

  it("a cancelled gesture does nothing", () => {
    const { commits } = run([
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE - 10),
      { phase: "cancel" },
      end,
    ]);
    expect(commits).toEqual([]);
  });

  it("ignores vertical scrolls, even with large sideways drift later", () => {
    const { commits } = run([
      begin(0, 20),
      ...swipe(-SWIPE_COMMIT_DISTANCE * 3),
      end,
    ]);
    expect(commits).toEqual([]);
  });

  it("ignores gestures that begin outside the swipe zone", () => {
    const { commits } = run(
      [begin(), ...swipe(-SWIPE_COMMIT_DISTANCE - 10), end],
      env({ targetAt: () => null }),
    );
    expect(commits).toEqual([]);
  });

  it("leaves the swipe to content that can still scroll that way", () => {
    const e = env({ targetAt: () => target({ back: true }) });
    expect(
      run([begin(), ...swipe(-SWIPE_COMMIT_DISTANCE - 10), end], e).commits,
    ).toEqual([]);
    expect(
      run([begin(), ...swipe(SWIPE_COMMIT_DISTANCE + 10), end], e).commits,
    ).toEqual(["forward"]);
  });

  it("does not track when there is nowhere to go", () => {
    const e = env({ canNavigate: (d) => d === "forward" });
    const swiped = [begin(), ...swipe(-SWIPE_COMMIT_DISTANCE - 10)];
    expect(run(swiped, e).state.kind).toBe("ignored");
    expect(run([...swiped, end], e).commits).toEqual([]);
  });

  it("each gesture navigates at most once", () => {
    const { commits } = run([
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE - 10),
      end,
      begin(),
      ...swipe(-SWIPE_COMMIT_DISTANCE - 10),
      end,
    ]);
    expect(commits).toEqual(["back", "back"]);
  });
});
