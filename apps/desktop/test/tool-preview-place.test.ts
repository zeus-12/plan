import { describe, expect, it } from "vitest";
import { placeCard } from "@/renderer/features/chat/transcript/tool-preview-card";

const VIEWPORT = { width: 1200, height: 800 };
const MARGIN = 8;

const pill = (top: number) => ({ top, bottom: top + 22, left: 100 });

/** Height the card settles at once the cap is applied. */
const settled = (height: number, placed: { maxHeight: number }): number =>
  Math.min(height, placed.maxHeight);

describe("placeCard", () => {
  it("sits just below the anchor when it fits", () => {
    const anchor = pill(100);
    const placed = placeCard(anchor, 200, 720, VIEWPORT);
    expect(placed.top).toBe(anchor.bottom + 6);
  });

  it("flips above when there is no room below", () => {
    const anchor = pill(700);
    const placed = placeCard(anchor, 300, 720, VIEWPORT);
    expect(placed.top).toBe(anchor.top - 6 - 300);
  });

  it("caps the height to the room on the chosen side", () => {
    // 140px of room below, ~700 above → goes above, capped by the 60vh ceiling.
    const placed = placeCard(pill(640), 5000, 720, VIEWPORT);
    expect(placed.maxHeight).toBe(VIEWPORT.height * 0.6);
    expect(placed.top).toBeGreaterThanOrEqual(MARGIN);
  });

  it("never lets a card that grows after placement leave the viewport", () => {
    // Every anchor position, at every height a card can reach — the collapsed
    // runs in a file diff can expand to any of these.
    for (let top = 0; top <= VIEWPORT.height - 22; top += 7) {
      for (const height of [40, 120, 300, 480, 900, 4000]) {
        const anchor = pill(top);
        const placed = placeCard(anchor, height, 720, VIEWPORT);
        const bottom = placed.top + settled(height, placed);
        expect(placed.top).toBeGreaterThanOrEqual(MARGIN);
        expect(bottom).toBeLessThanOrEqual(VIEWPORT.height - MARGIN);
      }
    }
  });

  it("keeps the width inside the viewport", () => {
    expect(placeCard(pill(100), 200, 720, VIEWPORT).left).toBe(100);
    const wide = placeCard({ top: 100, bottom: 122, left: 900 }, 200, 720, {
      width: 800,
      height: 800,
    });
    expect(wide.left + 720).toBe(800 - MARGIN);
  });

  it("settles: re-placing at the capped height keeps the same box", () => {
    for (let top = 0; top <= VIEWPORT.height - 22; top += 13) {
      const anchor = pill(top);
      const first = placeCard(anchor, 4000, 720, VIEWPORT);
      const second = placeCard(anchor, settled(4000, first), 720, VIEWPORT);
      expect(second).toEqual(first);
    }
  });
});
