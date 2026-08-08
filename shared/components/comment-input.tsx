import { createContext, useContext } from "react";
import type {
  ForwardRefExoticComponent,
  ReactNode,
  RefAttributes,
} from "react";

export interface CommentInputProps {
  /** Seed text. The input owns its document from then on and reports edits
   *  through {@link onChange} — it is not re-driven from this prop. */
  initialValue: string;
  onChange: (next: string) => void;
  /** ⌘↵. */
  onSubmit: () => void;
  /** Flips true once the card has been measured and is visible; a hidden
   *  element can't take focus. */
  autoFocus: boolean;
  placeholder: string;
  minHeight: number;
  maxHeight: number;
}

export interface CommentInputHandle {
  /** True when the input holds a selection of its own, so ⌘C means "copy that"
   *  rather than "copy the text being commented on". */
  hasSelection(): boolean;
  /** True while a completion menu owns the keystroke — Escape closes the menu,
   *  not the comment card. */
  isMenuOpen(): boolean;
}

export type CommentInputComponent = ForwardRefExoticComponent<
  CommentInputProps & RefAttributes<CommentInputHandle>
>;

const CommentInputContext = createContext<CommentInputComponent | null>(null);

/**
 * Supplies the rich comment editor — the one that renders `@file` and `/skill`
 * as chips and completes them as you type.
 *
 * Injected rather than imported because comment surfaces also render in the web
 * build, which has no project index, no skills on disk, and no reason to ship an
 * editor framework for a text box. No provider means the popover falls back to
 * its plain textarea, which is exactly right there.
 */
export function CommentInputProvider({
  input,
  children,
}: {
  input: CommentInputComponent;
  children: ReactNode;
}) {
  return (
    <CommentInputContext.Provider value={input}>
      {children}
    </CommentInputContext.Provider>
  );
}

export function useCommentInput(): CommentInputComponent | null {
  return useContext(CommentInputContext);
}
