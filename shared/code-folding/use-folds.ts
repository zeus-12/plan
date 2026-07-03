import { useEffect, useState } from "react";
import type { FoldEngine, FoldRange } from "./types";

const EMPTY: FoldRange[] = [];

/**
 * Fold ranges for `text` from the given engine, handling both sync and async
 * engines uniformly. A synchronous engine (indentation) resolves on the very
 * first render via the lazy initial state — no flash. An async engine
 * (tree-sitter in a worker) starts empty and fills in when its parse resolves;
 * stale results from a previous text/engine are dropped.
 */
export function useFolds(
  engine: FoldEngine,
  text: string,
  languageId: string,
): FoldRange[] {
  const [folds, setFolds] = useState<FoldRange[]>(() => {
    const r = engine.computeFolds(text, languageId);
    return Array.isArray(r) ? r : EMPTY;
  });

  useEffect(() => {
    const r = engine.computeFolds(text, languageId);
    if (Array.isArray(r)) {
      setFolds(r);
      return;
    }
    let cancelled = false;
    r.then((res) => {
      if (!cancelled) setFolds(res);
    }).catch(() => {
      if (!cancelled) setFolds(EMPTY);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, text, languageId]);

  return folds;
}
