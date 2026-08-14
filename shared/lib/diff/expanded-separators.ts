"use client";

import { useCallback, useMemo, useState } from "react";
import { toggleInSet } from "../utils";

/* Which "N unchanged lines" separators the user has manually expanded.
 *
 * The host owns this rather than the diff because two components need it: the
 * diff renders the expanded rows, and the settings controls need to know the
 * view is in a mixed state — neither "Changes only" nor "All lines" — so that
 * clicking "Changes only" collapses the expansions instead of re-firing a
 * settings change that wouldn't alter anything. */

export interface ExpandedSeparators {
  expanded: ReadonlySet<number>;
  /** True once the user has expanded at least one separator by hand. */
  customized: boolean;
  toggle: (idx: number) => void;
  expandAll: (count: number) => void;
  collapseAll: () => void;
}

export function useExpandedSeparators(): ExpandedSeparators {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const toggle = useCallback(
    (idx: number) => setExpanded((prev) => toggleInSet(prev, idx)),
    [],
  );
  const expandAll = useCallback(
    (count: number) =>
      setExpanded(new Set(Array.from({ length: count }, (_, i) => i))),
    [],
  );
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  return useMemo(
    () => ({
      expanded,
      customized: expanded.size > 0,
      toggle,
      expandAll,
      collapseAll,
    }),
    [expanded, toggle, expandAll, collapseAll],
  );
}
