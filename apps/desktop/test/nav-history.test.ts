import { describe, expect, it } from "vitest";
import {
  NavHistory,
  type NavLocation,
} from "@/renderer/features/navigation/nav-history";

const loc = (encoded: string, tabId: string | null = null): NavLocation => ({
  projectEncoded: encoded,
  worktreeId: null,
  encoded,
  tabId,
});
const always = () => true;

describe("NavHistory", () => {
  it("has nowhere to go before a second visit", () => {
    const h = new NavHistory();
    expect(h.peek("back", always)).toBeNull();
    h.record(loc("a", "t1"));
    expect(h.peek("back", always)).toBeNull();
    expect(h.peek("forward", always)).toBeNull();
  });

  it("goes back and forward across projects", () => {
    const h = new NavHistory();
    h.record(loc("a", "t1"));
    h.record(loc("b", "t2"));
    h.record(loc("b", "t3"));
    expect(h.go(h.peek("back", always)!)).toEqual(loc("b", "t2"));
    expect(h.go(h.peek("back", always)!)).toEqual(loc("a", "t1"));
    expect(h.peek("back", always)).toBeNull();
    expect(h.go(h.peek("forward", always)!)).toEqual(loc("b", "t2"));
  });

  it("treats recording the location it just navigated to as a no-op", () => {
    const h = new NavHistory();
    h.record(loc("a", "t1"));
    h.record(loc("b", "t2"));
    h.record(h.go(h.peek("back", always)!));
    expect(h.go(h.peek("forward", always)!)).toEqual(loc("b", "t2"));
  });

  it("drops forward entries on a new visit", () => {
    const h = new NavHistory();
    h.record(loc("a", "t1"));
    h.record(loc("b", "t2"));
    h.go(h.peek("back", always)!);
    h.record(loc("c", "t3"));
    expect(h.peek("forward", always)).toBeNull();
    expect(h.go(h.peek("back", always)!)).toEqual(loc("a", "t1"));
  });

  it("skips entries that are no longer live", () => {
    const h = new NavHistory();
    h.record(loc("a", "t1"));
    h.record(loc("b", "gone"));
    h.record(loc("c", "t3"));
    const live = (l: NavLocation) => l.tabId !== "gone";
    expect(h.go(h.peek("back", live)!)).toEqual(loc("a", "t1"));
    expect(h.go(h.peek("forward", live)!)).toEqual(loc("c", "t3"));
  });

  it("skips entries equal to the current location", () => {
    const h = new NavHistory();
    h.record(loc("a", "t1"));
    h.record(loc("b", "gone"));
    h.record(loc("a", "t1"));
    const live = (l: NavLocation) => l.tabId !== "gone";
    expect(h.peek("back", live)).toBeNull();
  });

  it("caps its length, dropping the oldest", () => {
    const h = new NavHistory(2);
    h.record(loc("a"));
    h.record(loc("b"));
    h.record(loc("c"));
    expect(h.go(h.peek("back", always)!)).toEqual(loc("b"));
    expect(h.peek("back", always)).toBeNull();
  });
});
