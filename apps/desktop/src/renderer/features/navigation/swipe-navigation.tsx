import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import type { NavDirection } from "./nav-history";
import {
  IDLE,
  stepSwipe,
  swipeProgress,
  type SwipeEnv,
  type SwipeRect,
  type SwipeState,
  type SwipeTarget,
} from "./swipe-recognizer";

const ARROW_SIZE = 36;
const ARROW_INSET = 16;

function swipeTargetAt(x: number, y: number): SwipeTarget | null {
  const hit = document.elementFromPoint(x, y);
  const zone = hit?.closest("[data-swipe-nav-zone]");
  if (!hit || !zone) return null;
  const canScroll = { back: false, forward: false };
  for (
    let el: Element | null = hit;
    el && el !== zone.parentElement;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth)
      continue;
    const isField =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (!isField && !/auto|scroll|overlay/.test(getComputedStyle(el).overflowX))
      continue;
    if (el.scrollLeft > 0) canScroll.back = true;
    if (el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
      canScroll.forward = true;
  }
  const r = zone.getBoundingClientRect();
  return {
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    canScroll,
  };
}

interface Indicator {
  direction: NavDirection;
  progress: number;
  rect: SwipeRect;
}

interface Props {
  canNavigate: (direction: NavDirection) => boolean;
  navigate: (direction: NavDirection) => void;
}

/**
 * Two-finger trackpad swipe over the content pane goes back/forward. Drives an
 * edge arrow from the gesture's real travel; navigation happens on finger lift.
 */
export function SwipeNavigation({ canNavigate, navigate }: Props) {
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const handlers = useRef({ canNavigate, navigate });
  handlers.current = { canNavigate, navigate };

  useEffect(() => {
    let state: SwipeState = IDLE;
    const env: SwipeEnv = {
      targetAt: swipeTargetAt,
      canNavigate: (d) => handlers.current.canNavigate(d),
    };
    return window.electronAPI.onSwipeGesture((event) => {
      const next = stepSwipe(state, event, env);
      state = next.state;
      setIndicator(
        state.kind === "tracking"
          ? {
              direction: state.direction,
              progress: swipeProgress(state),
              rect: state.target.rect,
            }
          : null,
      );
      if (next.commit) handlers.current.navigate(next.commit);
    });
  }, []);

  if (!indicator) return null;
  const { direction, progress, rect } = indicator;
  const armed = progress >= 1;
  const offset = -ARROW_SIZE + progress * (ARROW_SIZE + ARROW_INSET);
  const Icon = direction === "back" ? ArrowLeft : ArrowRight;
  return (
    <div
      className="pointer-events-none fixed z-[90] overflow-hidden"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    >
      <div
        className={cn(
          "absolute flex items-center justify-center rounded-full border shadow-lg transition-colors duration-150",
          armed
            ? "border-transparent bg-[var(--accent)] text-[var(--bg)]"
            : "border-[var(--popover-border)] bg-[var(--popover-bg)] text-[var(--text-secondary)]",
        )}
        style={{
          width: ARROW_SIZE,
          height: ARROW_SIZE,
          top: rect.height / 2 - ARROW_SIZE / 2,
          [direction === "back" ? "left" : "right"]: offset,
          opacity: 0.3 + 0.7 * progress,
        }}
      >
        <Icon size={18} strokeWidth={2} />
      </div>
    </div>
  );
}
