import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import type {
  CommentInputComponent,
  CommentInputHandle,
} from "@plan/shared/components/comment-input";
import { ReferenceNode } from "./reference-node";
import { FileMentionPlugin, SkillMentionPlugin } from "./mention-plugins";
import { isMentionMenuOpen } from "./mention-menu-state";

/** One paragraph with explicit line breaks, so `getTextContent()` round-trips
 *  the comment exactly — paragraphs would come back joined by a blank line. */
function seedState(text: string) {
  return () => {
    const root = $getRoot();
    root.clear();
    const paragraph = $createParagraphNode();
    text.split("\n").forEach((line, i) => {
      if (i > 0) paragraph.append($createLineBreakNode());
      if (line) paragraph.append($createTextNode(line));
    });
    root.append(paragraph);
  };
}

function EditorRef({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  return null;
}

function ChangePlugin({ onChange }: { onChange: (next: string) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        onChange(editorState.read(() => $getRoot().getTextContent()));
      }),
    [editor, onChange],
  );
  return null;
}

function SubmitPlugin({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand<KeyboardEvent | null>(
        KEY_ENTER_COMMAND,
        (e) => {
          // A mention menu is open — Enter picks the highlighted option.
          if (isMentionMenuOpen()) return false;
          if (!e || !(e.metaKey || e.ctrlKey)) return false; // plain ↵ = newline
          e.preventDefault();
          // The comments panel arms its own window-level ⌘↵ whenever the chat
          // composer is blurred. Without this the same stroke would submit the
          // comment and flush the whole buffer to chat.
          e.stopImmediatePropagation();
          onSubmit();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, onSubmit],
  );
  return null;
}

function FocusPlugin({ autoFocus }: { autoFocus: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (autoFocus) editor.focus(undefined, { defaultSelection: "rootEnd" });
  }, [editor, autoFocus]);
  return null;
}

/**
 * The comment popover's input, for surfaces that have a project behind them:
 * a plain-text Lexical editor whose only rich content is the `@file` / `/skill`
 * chip, completed by the same menus the chat composer uses. Its text content is
 * the literal `@path` / `/name` Claude Code resolves, so the comment serializes
 * into the outgoing message unchanged.
 */
export function makeCommentInput(
  projectEncoded: string,
): CommentInputComponent {
  return forwardRef<
    CommentInputHandle,
    React.ComponentProps<CommentInputComponent>
  >(function CommentEditor(
    {
      initialValue,
      onChange,
      onSubmit,
      autoFocus,
      placeholder,
      minHeight,
      maxHeight,
    },
    ref,
  ) {
    const editorRef = useRef<LexicalEditor | null>(null);

    useImperativeHandle(ref, () => ({
      hasSelection: () =>
        editorRef.current?.getEditorState().read(() => {
          const selection = $getSelection();
          return selection != null && !selection.isCollapsed();
        }) ?? false,
      isMenuOpen: isMentionMenuOpen,
    }));

    return (
      <div className="relative">
        <LexicalComposer
          initialConfig={{
            namespace: "comment-input",
            nodes: [ReferenceNode],
            editorState: seedState(initialValue),
            onError: (e) => console.error("[comment-input] lexical:", e),
            theme: {},
          }}
        >
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Comment"
                aria-placeholder={placeholder}
                placeholder={
                  <div className="pointer-events-none absolute left-0 top-0 select-none text-[13.5px] leading-[21px] text-[var(--text-tertiary)]">
                    {placeholder}
                  </div>
                }
                spellCheck={false}
                style={{ minHeight, maxHeight }}
                className="scrollbar-minimal w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[13.5px] leading-[21px] text-[var(--text)] outline-none"
              />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <EditorRef editorRef={editorRef} />
          <ChangePlugin onChange={onChange} />
          <SubmitPlugin onSubmit={onSubmit} />
          <FocusPlugin autoFocus={autoFocus} />
          <FileMentionPlugin projectEncoded={projectEncoded} />
          <SkillMentionPlugin projectEncoded={projectEncoded} />
        </LexicalComposer>
      </div>
    );
  });
}
