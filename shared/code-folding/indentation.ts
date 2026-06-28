import { computeFoldRanges } from "../lib/folding";
import type { FoldEngine } from "./types";

/**
 * The universal, dependency-free fold engine: VS Code's indentation strategy
 * (see {@link computeFoldRanges}). It's the default everywhere and the fallback
 * the desktop app drops back to if the tree-sitter engine is removed or a
 * language has no grammar. Synchronous — no flash, no worker.
 */
export const indentationFoldEngine: FoldEngine = {
  name: "indentation",
  computeFolds(text) {
    return computeFoldRanges(text.split("\n"));
  },
};
