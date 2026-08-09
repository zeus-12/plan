"use client";

import * as React from "react";

import { cn } from "../../lib/utils";

// Port of beui.dev's motion range slider (components/motion/range-slider).
// Their springs are reproduced inline rather than pulled from `motion`, which
// this repo does not depend on.

const TRACK_HEIGHT = 20;
const THUMB_HEIGHT = 25;
const THUMB_WIDTH = 6;

/** Position: overdamped (ratio 1.34), so it tracks the pointer without rebound. */
const SPRING_GLIDE = { stiffness: 700, damping: 50, mass: 0.5 };
/** Grab feedback on the thumb's scaleY only, never on position. */
const SPRING_BOUNCY = { stiffness: 500, damping: 14, mass: 0.7 };

// BeUI grows the thumb by 7px on a 40px track — 17.5% of track height. Holding
// that ratio at 20px gives 3.5px, so 25px of thumb presses to 28.5px. Their
// literal 1.35 would reach 33.75px here and read as a lurch.
const PRESS_SCALE = 1 + (TRACK_HEIGHT * 0.175) / THUMB_HEIGHT;

const ROW_HEIGHT = Math.ceil(
  Math.max(TRACK_HEIGHT, THUMB_HEIGHT * PRESS_SCALE),
);

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

function snapValue(next: number, min: number, max: number, step: number) {
  if (!(max > min)) return min;
  if (!(step > 0)) return clamp(next, min, max);
  const whole = Math.floor(Number(((max - min) / step).toFixed(6)));
  const lastWhole = Number((min + whole * step).toFixed(6));
  const toGrid = clamp(
    Math.round((next - min) / step) * step + min,
    min,
    lastWhole,
  );
  const snapped =
    lastWhole < max && Math.abs(next - max) <= Math.abs(next - toGrid)
      ? max
      : toGrid;
  return Number(snapped.toFixed(6));
}

type SpringConfig = { stiffness: number; damping: number; mass: number };

/** Damped harmonic oscillator on rAF. Velocity survives a target change, which
 *  is what a CSS transition cannot do — it restarts from rest on every step. */
function createSpring(
  initial: number,
  config: SpringConfig,
  onFrame: (value: number) => void,
) {
  let x = initial;
  let v = 0;
  let target = initial;
  let raf = 0;
  let last = 0;
  let reduced = false;

  const tick = (now: number) => {
    const dt = Math.min(0.064, (now - last) / 1000) || 0.016;
    last = now;
    // 1ms substeps: stiffness 700 goes unstable at raw frame deltas.
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(0.001, remaining);
      const a =
        (-config.stiffness * (x - target) - config.damping * v) / config.mass;
      v += a * h;
      x += v * h;
      remaining -= h;
    }
    onFrame(x);
    if (Math.abs(x - target) < 0.002 && Math.abs(v) < 0.02) {
      x = target;
      v = 0;
      onFrame(x);
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  return {
    setReduced(next: boolean) {
      reduced = next;
    },
    set(next: number) {
      target = next;
      if (reduced) {
        x = next;
        v = 0;
        onFrame(x);
        return;
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    jump(next: number) {
      target = next;
      x = next;
      v = 0;
      onFrame(x);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

interface Props {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  formatValue?: (value: number) => string;
  className?: string;
}

export function RangeSlider({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  label,
  formatValue,
  className,
}: Props) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const fillRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  const draggingRef = React.useRef(false);

  const posRef = React.useRef(0);
  const scaleRef = React.useRef(1);
  const posSpring = React.useRef<ReturnType<typeof createSpring> | null>(null);
  const scaleSpring = React.useRef<ReturnType<typeof createSpring> | null>(
    null,
  );

  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const paint = React.useCallback(() => {
    const p = posRef.current;
    if (fillRef.current) fillRef.current.style.width = `${p}%`;
    if (thumbRef.current) {
      thumbRef.current.style.left = `${p}%`;
      // Self-offset by -p% of the thumb's own width keeps it inside the track
      // at both ends — flush left at 0, flush right at 100, no clip, no gap.
      thumbRef.current.style.transform = `translate(${-p}%, -50%) scaleY(${scaleRef.current})`;
    }
  }, []);

  React.useEffect(() => {
    posSpring.current = createSpring(percent, SPRING_GLIDE, (p) => {
      posRef.current = p;
      paint();
    });
    scaleSpring.current = createSpring(1, SPRING_BOUNCY, (s) => {
      scaleRef.current = s;
      paint();
    });
    posSpring.current.jump(percent);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      posSpring.current?.setReduced(mq.matches);
      scaleSpring.current?.setReduced(mq.matches);
    };
    sync();
    mq.addEventListener("change", sync);

    return () => {
      mq.removeEventListener("change", sync);
      posSpring.current?.stop();
      scaleSpring.current?.stop();
    };
    // Mount only: `percent` seeds the spring, later changes go through the
    // effect below so a re-render never snaps the thumb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    posSpring.current?.set(percent);
  }, [percent]);

  const commitFromX = React.useCallback(
    (clientX: number) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const next = snapValue(min + ratio * (max - min), min, max, step);
      if (next !== value) onValueChange(next);
    },
    [min, max, step, value, onValueChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    thumbRef.current?.focus({ preventScroll: true });
    scaleSpring.current?.set(PRESS_SCALE);
    commitFromX(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    commitFromX(e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!draggingRef.current) return;
    draggingRef.current = false;
    scaleSpring.current?.set(1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      Home: min,
      End: max,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = snapValue(clamp(moves[e.key], min, max), min, max, step);
    if (next !== value) onValueChange(next);
  };

  const stops = Math.floor(Number(((max - min) / step).toFixed(6))) + 1;

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "relative flex w-full cursor-grab touch-none items-center select-none active:cursor-grabbing",
        className,
      )}
    >
      {/* Clipping is confined to this box: the thumb is taller than the track
          and would be sliced if it lived inside an overflow-hidden parent. */}
      <div
        style={{ height: TRACK_HEIGHT }}
        className="relative w-full overflow-hidden rounded-lg bg-[var(--bg-surface)]"
      >
        <div
          ref={fillRef}
          className="absolute inset-y-0 left-0 bg-[var(--text)]/15"
        />
        {/* Inset by half a thumb — the span the thumb's centre actually travels,
            so every dot sits exactly where the thumb lands. */}
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ left: THUMB_WIDTH / 2, right: THUMB_WIDTH / 2 }}
        >
          {Array.from({ length: stops }, (_, i) => (
            <span
              key={i}
              className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text)]/25"
              style={{ left: `${(i / (stops - 1)) * 100}%` }}
            />
          ))}
        </div>
      </div>

      <div
        ref={thumbRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatValue?.(value)}
        onKeyDown={onKeyDown}
        style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT }}
        className="absolute top-1/2 rounded-[3px] bg-[var(--text)] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />
    </div>
  );
}
