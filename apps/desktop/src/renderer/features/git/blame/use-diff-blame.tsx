import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DiffBlame } from "@plan/shared/components/interactive-diff";
import { blameLineInfo, tagBlame, type TextBlame } from "./blame";
import { useBlameCard } from "./use-blame-card";

/**
 * What one diff side's blame is computed against. Either way the source
 * carries the exact text that side renders, so results can be tagged with it
 * and staleness stays a reference-equality check:
 *  - "contents": blame the text as the working-tree version (`--contents`) —
 *    the local Changes tab, where text may be HEAD/index/worktree state.
 *  - "rev": blame the file as of a commit (`git blame <rev>`) — a PR head
 *    blob; `text` must be that blob's contents.
 */
export type DiffBlameSource =
  | { kind: "contents"; text: string }
  | { kind: "rev"; rev: string; text: string };

function useSideBlame(
  encoded: string,
  relPath: string,
  source: DiffBlameSource | null,
): TextBlame | null {
  const [blame, setBlame] = useState<TextBlame | null>(null);
  // Primitive deps: a source object is rebuilt every render, but a fetch
  // should re-run only when what it's keyed on actually changes.
  const kind = source?.kind ?? null;
  const rev = source?.kind === "rev" ? source.rev : null;
  const text = source?.text ?? "";
  useEffect(() => {
    // Cleared first — stale blame must never paint on new text.
    setBlame(null);
    if (!kind || !text) return;
    let cancelled = false;
    const result =
      kind === "rev"
        ? window.electronAPI.blameRev(encoded, relPath, rev!)
        : window.electronAPI.blameContents(encoded, relPath, text);
    result.then((r) => {
      if (!cancelled) setBlame(tagBlame(r, text));
    });
    return () => {
      cancelled = true;
    };
  }, [encoded, relPath, kind, rev, text]);
  // Trusted only while its tag IS the side's rendered text.
  return blame && blame.forText === text ? blame : null;
}

/**
 * Everything a diff surface needs for inline blame: fetches one blame per
 * side against exactly the text that side renders, builds InteractiveDiff's
 * `blame` prop, and owns the hover card. Callers place `card` in their tree
 * and close it on scroll (`hasCard` + `closeCard`); text changes close it
 * automatically.
 */
export function useDiffBlame(
  encoded: string,
  relPath: string,
  left: DiffBlameSource | null,
  right: DiffBlameSource | null,
): {
  blame: DiffBlame | undefined;
  card: ReactNode;
  hasCard: boolean;
  closeCard: () => void;
} {
  const blameL = useSideBlame(encoded, relPath, left);
  const blameR = useSideBlame(encoded, relPath, right);
  const { card, hasCard, chipEnter, chipLeave, open, close } = useBlameCard(
    encoded,
    relPath,
  );

  const blame = useMemo<DiffBlame | undefined>(() => {
    if (!blameL && !blameR) return undefined;
    const infoAt = (side: "left" | "right", num: number) => {
      const b = side === "left" ? blameL : blameR;
      return b ? blameLineInfo(b, num - 1) : null;
    };
    return {
      labelFor: (side, num) => infoAt(side, num)?.label ?? null,
      onChipEnter: (side, num, rect) => {
        const info = infoAt(side, num);
        if (info) chipEnter(rect, info);
      },
      onChipLeave: chipLeave,
      onChipClick: (side, num, rect) => {
        const info = infoAt(side, num);
        if (info) open(rect, info);
      },
    };
  }, [blameL, blameR, chipEnter, chipLeave, open]);

  // The card is fixed-position — drop it when the text under it changes.
  const leftText = left?.text ?? "";
  const rightText = right?.text ?? "";
  useEffect(() => {
    close();
  }, [leftText, rightText, close]);

  return { blame, card, hasCard, closeCard: close };
}
