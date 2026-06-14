import { useCallback, useState } from "react";
import { useSelectionCommit } from "./use-selection-commit";

/**
 * A settled text selection ready to be commented on. `data` is whatever the
 * surface needs to anchor the comment (line range, char offsets + side, message
 * coordinates, …); the hook treats it as opaque.
 */
export interface SelectionAnchor<T> {
  data: T;
  selectedText: string;
  position: { top: number; left: number };
}

export interface UseCommentSelectionOptions<T> {
  /** Disable while the surface is hidden (mounted-but-display:none panes). */
  enabled?: boolean;
  /**
   * Map the committed DOM selection to a surface-specific anchor, or `null` to
   * ignore it (collapsed, empty, or outside this surface). Return `position` to
   * place the popover; omit it to default to just below the selection rect.
   *
   * Wrap this in `useCallback` so the underlying document listener is stable.
   */
  resolve: (
    range: Range,
    selection: Selection
  ) => {
    data: T;
    selectedText: string;
    position?: { top: number; left: number };
  } | null;
  /**
   * Persist a new comment for the resolved anchor. This is the single place a
   * surface plugs in its store — e.g. `(data, text, comment) => store.add(...)`.
   */
  onCreate: (data: T, selectedText: string, comment: string) => void;
}

export interface UseCommentSelectionResult<T> {
  /** The selection awaiting a comment, or null. Drives the popover + the
   * surface's own persistent highlight (so it survives the popover stealing
   * focus, which clears the native selection). */
  pending: SelectionAnchor<T> | null;
  /** Commit `pending` with the given comment text. */
  submit: (comment: string) => void;
  /** Dismiss `pending` without creating a comment. */
  cancel: () => void;
}

/**
 * Shared text-selection → comment machinery used by the chat, diff, plan, and
 * file surfaces. It owns the gesture lifecycle (debounced commit via
 * {@link useSelectionCommit}, pending state, submit/cancel); each surface
 * supplies only how to anchor a selection (`resolve`) and how to persist it
 * (`onCreate`), and renders the popover + its own pending highlight from
 * `pending`.
 */
export function useCommentSelection<T>(
  opts: UseCommentSelectionOptions<T>
): UseCommentSelectionResult<T> {
  const { enabled = true, resolve, onCreate } = opts;
  const [pending, setPending] = useState<SelectionAnchor<T> | null>(null);

  const handle = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
      return;
    const range = selection.getRangeAt(0);
    const resolved = resolve(range, selection);
    if (!resolved) return;
    const position =
      resolved.position ??
      (() => {
        const r = range.getBoundingClientRect();
        return { top: r.bottom + 8, left: r.left };
      })();
    setPending({
      data: resolved.data,
      selectedText: resolved.selectedText,
      position,
    });
  }, [resolve]);

  useSelectionCommit(handle, enabled);

  const submit = useCallback(
    (comment: string) => {
      if (!pending) return;
      onCreate(pending.data, pending.selectedText, comment);
      setPending(null);
      window.getSelection()?.removeAllRanges();
    },
    [pending, onCreate]
  );

  const cancel = useCallback(() => {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return { pending, submit, cancel };
}
