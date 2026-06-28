import type { FoldRange } from "../lib/folding";

export type { FoldRange };

/**
 * A pluggable source of fold ranges. The renderer never knows *how* folds are
 * computed — it just asks the active engine. This is the seam that keeps the
 * tree-sitter ("preset") path fully swappable: delete its engine + the one place
 * it's provided, and everything falls back to {@link indentationFoldEngine}.
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
    languageId: string
  ): FoldRange[] | Promise<FoldRange[]>;
}
