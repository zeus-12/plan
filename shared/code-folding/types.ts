import type { FoldRange } from "./folding";

export type { FoldRange };

/** A code symbol (function/class/method/…) for the ⌘⇧G "go to symbol" palette. */
export interface CodeSymbol {
  /** Symbol name, e.g. the function/class identifier. */
  name: string;
  /** Kind from the tags query, e.g. "function", "class", "method", "interface". */
  kind: string;
  /** 0-based line of the definition. */
  line: number;
}

/**
 * A pluggable source of fold ranges (and, optionally, code symbols). The
 * renderer never knows *how* these are computed — it just asks the active
 * engine. This is the seam that keeps the tree-sitter ("preset") path fully
 * swappable: delete its engine + the one place it's provided, and everything
 * falls back to {@link indentationFoldEngine}.
 */
export interface FoldEngine {
  /** Stable identifier for debugging/telemetry (e.g. "indentation", "tree-sitter"). */
  readonly name: string;
  /**
   * Fold ranges for `text`. May resolve synchronously (indentation) or
   * asynchronously (a parser running off the main thread). Implementations must
   * resolve to `[]` on failure — never throw — so the UI degrades to "no folds"
   * rather than breaking the viewer.
   */
  computeFolds(
    text: string,
    languageId: string,
  ): FoldRange[] | Promise<FoldRange[]>;
  /**
   * Code symbols for the "go to symbol" palette, or undefined if the engine
   * can't provide them (e.g. the indentation engine — symbols need real
   * parsing). Must resolve to `[]` on failure, never throw.
   */
  computeSymbols?(
    text: string,
    languageId: string,
  ): CodeSymbol[] | Promise<CodeSymbol[]>;
}
