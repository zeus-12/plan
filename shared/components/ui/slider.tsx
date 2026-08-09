"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "../../lib/utils";

// shadcn/ui slider (new-york), rethemed to this repo's CSS-variable tokens and
// with `showSteps` for discrete sliders: one dot per stop, painted under the
// range so only the stops ahead of the thumb show.

const THUMB_SIZE = 14;

function Slider({
  className,
  min = 0,
  max = 100,
  step = 1,
  showSteps = false,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  showSteps?: boolean;
}) {
  const stops = showSteps ? Math.floor((max - min) / step) + 1 : 0;

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      min={min}
      max={max}
      step={step}
      className={cn(
        "relative flex h-5 w-full cursor-pointer touch-none items-center select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1 w-full grow overflow-hidden rounded-full bg-[var(--border)]"
      >
        {stops > 1 &&
          Array.from({ length: stops }, (_, i) => (
            <span
              key={i}
              className="absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text-tertiary)]"
              style={{
                // Radix keeps the thumb inside the track, so both ends are
                // inset by half a thumb — the stops have to match.
                left: `calc(${THUMB_SIZE / 2}px + (100% - ${THUMB_SIZE}px) * ${i / (stops - 1)})`,
              }}
            />
          ))}
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full rounded-full bg-[var(--accent)]"
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
        className="block shrink-0 cursor-grab rounded-full border-2 border-[var(--accent)] bg-[var(--bg)] shadow-sm transition-shadow outline-none hover:ring-4 hover:ring-[var(--accent)]/20 focus-visible:ring-4 focus-visible:ring-[var(--accent)]/30 active:cursor-grabbing"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
