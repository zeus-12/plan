export type NavDirection = "back" | "forward";

/** Where the content pane was: a project's working copy or one of its
 *  worktrees (`encoded` names whichever it is), and the tab active there. */
export interface NavLocation {
  projectEncoded: string;
  worktreeId: string | null;
  encoded: string;
  tabId: string | null;
}

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.encoded === b.encoded && a.tabId === b.tabId;
}

/**
 * Browser-style back/forward over content-pane locations, across projects and
 * worktrees. Visiting somewhere new drops the forward entries; entries whose
 * tab or worktree no longer exists are skipped, never navigated to.
 */
export class NavHistory {
  private entries: NavLocation[] = [];
  private index = -1;

  constructor(private readonly limit = 200) {}

  record(location: NavLocation): void {
    const current = this.entries[this.index];
    if (current && sameLocation(current, location)) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(location);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  /** Index of the nearest live entry in `direction` that differs from where
   *  we are now, or null when there is nowhere to go. */
  peek(
    direction: NavDirection,
    isLive: (location: NavLocation) => boolean,
  ): number | null {
    const current = this.entries[this.index];
    if (!current) return null;
    const step = direction === "back" ? -1 : 1;
    for (
      let i = this.index + step;
      i >= 0 && i < this.entries.length;
      i += step
    ) {
      const entry = this.entries[i];
      if (!sameLocation(entry, current) && isLive(entry)) return i;
    }
    return null;
  }

  /** Move to an index from `peek`; the caller then applies the location, and
   *  recording it is a no-op because it is already the current entry. */
  go(index: number): NavLocation {
    this.index = index;
    return this.entries[index];
  }
}
