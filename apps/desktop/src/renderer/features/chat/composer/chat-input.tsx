import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  HISTORY_MERGE_TAG,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { Kbd } from "@plan/shared/components/ui/kbd";
import {
  capHistoryDepth,
  clearLastSent,
  readLastSent,
  saveHistory,
  takeHistory,
  writeLastSent,
} from "./composer-memory";
import { ReferenceNode } from "@/renderer/features/mentions/reference-node";
import {
  FileMentionPlugin,
  SkillMentionPlugin,
} from "@/renderer/features/mentions/mention-plugins";
import { isMentionMenuOpen } from "@/renderer/features/mentions/mention-menu-state";

export interface ChatInputHandle {
  focus: () => void;
}

interface Props {
  /** Session this composer belongs to — keys the persisted draft. */
  sessionId: string;
  /** Project id — sources the `@` file list and `/` skill list. */
  projectEncoded: string;
  onSend: (text: string, imagePaths: string[]) => void;
  /** No live terminal yet — clicking the box starts one (see onStart). */
  inactive?: boolean;
  onStart?: () => void;
  /** Terminal is open but Claude hasn't finished booting yet. Composing stays
   *  enabled so a message can be drafted, but send is held back: a TUI that
   *  isn't ready drops the trailing Enter, leaving the message pasted-but-unsent.
   *  Driven by the same agent-live signal the header status badge shows. */
  notReady?: boolean;
  /** Focus the editor when this session becomes the composer's session. */
  autoFocus?: boolean;
  /** EXPERIMENTAL: Claude appears to be on a selection menu (no text box), so
   *  sending free text would mis-navigate it. Send is blocked; Enter reveals
   *  the terminal instead. The draft is kept so nothing is lost. */
  blocked?: boolean;
  /** Invoked when the user tries to send while blocked (reveals the terminal). */
  onBlocked?: () => void;
  /** Comments are waiting in the chip above — they go out with this message, so
   *  send stays available even when the draft itself is empty. */
  commentsPending?: boolean;
  /** This session's last turn died on a recoverable API error and nothing has
   *  been sent since — offer the one-click nudge. */
  canContinue?: boolean;
  /** This session's last turn hit the session limit (a rate_limit turn). Unlike
   *  {@link canContinue} this is never auto-retried — it only ever offers the
   *  manual nudge, which resumes the work once the limit resets. */
  atSessionLimit?: boolean;
  /** Reset clause Claude printed ("resets 3:10pm (Asia/Calcutta)"), shown in the
   *  session-limit pill. Null when the line wasn't in a shape we could read. */
  sessionLimitReset?: string | null;
  /** The nudge was clicked while the session was cold: its `claude` is booting
   *  and the message goes the moment the agent is actually live. */
  continueStarting?: boolean;
  onContinue?: () => void;
}

interface Attachment {
  id: string;
  /** Object URL of the pasted blob — shows instantly. */
  previewUrl: string;
  /** Temp-file path once saved; null while the background save is running. */
  path: string | null;
}

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 260;
const draftKey = (sid: string) => `plan.draft.${sid}`;

/** Validate then return a stored draft for use as Lexical's initial state. */
function readDraft(sid: string): string | undefined {
  const raw = window.localStorage.getItem(draftKey(sid));
  if (!raw) return undefined;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return undefined;
  }
}

// Pasted images are part of the draft too: persist their saved temp-file paths
// alongside the text so a project/session switch can restore them. The blob
// object URL dies with the component, so a restored chip previews from the file
// itself (file://) instead — the temp file is what actually gets sent anyway.
const imagesKey = (sid: string) => `${draftKey(sid)}.images`;

function readAttachmentPaths(sid: string): string[] {
  const raw = window.localStorage.getItem(imagesKey(sid));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function writeAttachmentPaths(sid: string, paths: string[]) {
  if (paths.length === 0) window.localStorage.removeItem(imagesKey(sid));
  else window.localStorage.setItem(imagesKey(sid), JSON.stringify(paths));
}

function attachmentsFromPaths(paths: string[]): Attachment[] {
  return paths.map((path) => ({
    id: crypto.randomUUID(),
    previewUrl: `file://${path}`,
    path,
  }));
}

/** Object URLs need freeing; restored file:// previews don't. */
const revokeIfBlob = (url: string) => {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
};

/**
 * Message composer. ⌘Enter sends, Enter inserts a newline.
 *
 * Built on a Lexical contenteditable so `@file` / `/skill` references render as
 * atomic, clickable chips (see {@link ReferenceNode}) while still serializing to
 * the plain `@path` / `/name` text the Claude Code TUI consumes. The editor
 * state lives HERE so a keystroke re-renders only this small component; drafts
 * (chips included) persist per session with debounced localStorage writes.
 *
 * Pasted images appear as chips instantly (the preview is the pasted blob); the
 * temp-file save runs in the background and Send stays disabled until every
 * attachment has a real path — the paths are what actually get sent.
 */
export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    sessionId,
    projectEncoded,
    onSend,
    inactive,
    onStart,
    notReady,
    autoFocus,
    blocked,
    onBlocked,
    commentsPending,
    canContinue,
    atSessionLimit,
    sessionLimitReset,
    continueStarting,
    onContinue,
  },
  ref,
) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [focused, setFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(
    () => readDraft(sessionId) === undefined,
  );
  // True while the draft's first non-space char is "!", mirroring Claude's TUI
  // bash mode. The text is sent verbatim — the "!" is the trigger — this only
  // drives the visual cue so the user knows the line goes to the shell.
  const [bashMode, setBashMode] = useState(false);

  const editorRef = useRef<LexicalEditor | null>(null);
  // A focus requested while the composer is still inactive (no live session)
  // can't land a caret — the editor is read-only. We park it here and fire it
  // the moment the session starts and the editor turns editable.
  const pendingFocusRef = useRef<(() => void) | null>(null);
  const commentsPendingRef = useRef(commentsPending);
  commentsPendingRef.current = commentsPending;

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => revokeIfBlob(a.previewUrl));
      return [];
    });
    setPreview(null);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) revokeIfBlob(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
    setPreview((p) => (p?.id === id ? null : p));
  }, []);

  const pendingSaves = attachments.some((a) => a.path === null);
  const canSend =
    !inactive &&
    !notReady &&
    !blocked &&
    !pendingSaves &&
    (!isEmpty || attachments.length > 0 || !!commentsPending);

  // Refs the editor's command handlers read so they always see latest state
  // without re-registering on every render.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const pendingSavesRef = useRef(pendingSaves);
  pendingSavesRef.current = pendingSaves;

  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  // True once the current session's stored attachments have been restored.
  // The persist effect below waits on this so the transient empty state
  // during a switch never overwrites the session we're switching *into*.
  const loadedRef = useRef(false);

  // Restore (or clear, on session switch) the pasted images for this session,
  // verifying each temp file still exists — the OS can purge it, and we never
  // show or send a path we can't confirm.
  useEffect(() => {
    loadedRef.current = false;
    let cancelled = false;
    setAttachments((prev) => {
      prev.forEach((a) => revokeIfBlob(a.previewUrl));
      return [];
    });
    setPreview(null);
    void (async () => {
      const paths = readAttachmentPaths(sessionId);
      const present = await Promise.all(
        paths.map((p) => window.electronAPI.fileExists(p)),
      );
      if (cancelled) return;
      const live = paths.filter((_, i) => present[i]);
      if (live.length !== paths.length) writeAttachmentPaths(sessionId, live);
      setAttachments(attachmentsFromPaths(live));
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
      attachmentsRef.current.forEach((a) => revokeIfBlob(a.previewUrl));
    };
  }, [sessionId]);

  // Persist saved attachment paths whenever they change, so a switch can
  // restore them. Gated on loadedRef so the clear above can't wipe the set.
  useEffect(() => {
    if (!loadedRef.current) return;
    writeAttachmentPaths(
      sessionRef.current,
      attachments.map((a) => a.path).filter((p): p is string => p !== null),
    );
  }, [attachments]);

  const send = useCallback(() => {
    if (blocked) {
      onBlocked?.();
      return;
    }
    if (inactive || notReady || pendingSavesRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor
      .getEditorState()
      .read(() => $getRoot().getTextContent())
      .trim();
    const imagePaths = attachmentsRef.current
      .map((a) => a.path)
      .filter((p): p is string => p !== null);
    if (!text && imagePaths.length === 0 && !commentsPendingRef.current) return;
    // Image paths are sent separately (not folded into the text) so the
    // terminal can type them as a real path the way a direct paste does.
    onSend(text, imagePaths);
    // Snapshot the full editor state so ⌘Z can bring it back verbatim.
    writeLastSent(
      sessionId,
      projectEncoded,
      JSON.stringify(editor.getEditorState().toJSON()),
    );
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      root.append(p);
      p.selectEnd();
    });
    clearAttachments();
    window.localStorage.removeItem(draftKey(sessionId));
    window.localStorage.removeItem(imagesKey(sessionId));
  }, [
    blocked,
    inactive,
    notReady,
    onBlocked,
    onSend,
    sessionId,
    projectEncoded,
    clearAttachments,
  ]);

  const sendRef = useRef(send);
  sendRef.current = send;

  // Pasted images: chip appears IMMEDIATELY (object URL of the blob); the
  // temp-file write happens in the background.
  const addImage = useCallback(
    (file: File, ext: string) => {
      const id = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, { id, previewUrl, path: null }]);
      void (async () => {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const path = await window.electronAPI.saveTempImage(buf, ext);
          if (path) {
            setAttachments((prev) =>
              prev.map((a) => (a.id === id ? { ...a, path } : a)),
            );
          } else {
            removeAttachment(id);
          }
        } catch {
          removeAttachment(id);
        }
      })();
    },
    [removeAttachment],
  );
  const addImageRef = useRef(addImage);
  addImageRef.current = addImage;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const editor = editorRef.current;
        if (!editor) return;
        if (editor.isEditable()) {
          editor.focus();
          return;
        }
        // Inactive composer (old chat with no live terminal): caller is
        // expected to kick off the session in parallel. Hold the focus until
        // the editor becomes editable, then place the caret so the user can
        // type. Replaces any earlier pending focus.
        pendingFocusRef.current?.();
        const unregister = editor.registerEditableListener((editable) => {
          if (!editable) return;
          unregister();
          pendingFocusRef.current = null;
          editor.focus();
        });
        pendingFocusRef.current = unregister;
      },
    }),
    [],
  );

  const placeholder = inactive
    ? "Click here to connect this chat to Claude…"
    : "What would you like to make?  @ files · / skills";

  return (
    <div className="shrink-0 px-3 pb-3 pt-0">
      {blocked && (
        <button
          onClick={onBlocked}
          className="mx-auto mb-2 flex w-full max-w-[820px] items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] text-amber-600 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
          <span>
            Claude may be on a menu (no text box) — respond in the terminal, not
            here.
          </span>
          <span className="ml-auto shrink-0">
            <Kbd keys={["⌘", "J"]} />
          </span>
        </button>
      )}
      {/* The last turn died mid-response. One click sends the nudge; nothing
          happens until it's clicked, so this shows regardless of the
          auto-continue setting (which only governs the silent retry). */}
      {canContinue && !blocked && (
        <div className="mx-auto mb-2 flex w-full max-w-[820px]">
          <button
            onClick={onContinue}
            disabled={continueStarting}
            title="Claude's last response was cut off — send “Please continue”"
            className="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-55 disabled:hover:bg-[var(--bg-surface)]"
          >
            {continueStarting ? "Starting session…" : "Please continue"}
          </button>
        </div>
      )}
      {/* Session limit hit. Never auto-retried (it would just re-hit the limit
          until it resets), so it lives only here — a manual nudge that resumes
          the turn once the window lifts. Amber matches the app's existing
          "needs your attention in this session" language (the blocked pill /
          approval dot). */}
      {atSessionLimit && !canContinue && !blocked && (
        <div className="mx-auto mb-2 flex w-full max-w-[820px] items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/[0.07] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[11px] text-amber-600 dark:text-amber-400">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
          <span className="min-w-0 truncate">
            You&apos;ve hit your session limit
            {sessionLimitReset ? ` · ${sessionLimitReset}` : ""}
          </span>
          <button
            onClick={onContinue}
            disabled={continueStarting}
            title="Once the limit resets, this sends “Please continue” to resume the turn"
            className="ml-auto shrink-0 rounded-full border border-amber-500/50 px-2.5 py-0.5 text-[11px] transition-colors hover:bg-amber-500/15 disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
          >
            {continueStarting ? "Starting…" : "Continue"}
          </button>
        </div>
      )}
      {/* Centered to match the message column's max width (see message-list). */}
      <div
        className={`mx-auto flex w-full max-w-[820px] flex-col rounded-xl border bg-[var(--bg-surface)] transition-colors ${
          bashMode
            ? "border-[var(--accent)]"
            : "border-[var(--border)] focus-within:border-[var(--border-strong)]"
        }`}
      >
        <div className="relative" onMouseDown={inactive ? onStart : undefined}>
          <LexicalComposer
            initialConfig={{
              namespace: "chat-input",
              nodes: [ReferenceNode],
              editorState: readDraft(sessionId),
              editable: !inactive,
              onError: (e) => console.error("[chat-input] lexical:", e),
              theme: {},
            }}
          >
            <PlainTextPlugin
              contentEditable={
                <ContentEditable
                  aria-placeholder={placeholder}
                  placeholder={
                    <div className="pointer-events-none absolute left-4 top-3 select-none text-[13px] leading-relaxed text-[var(--text-tertiary)]">
                      {placeholder}
                    </div>
                  }
                  spellCheck={false}
                  style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
                  className={`w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-1 pt-3 text-[13px] leading-relaxed text-[var(--text)] outline-none ${
                    inactive ? "cursor-pointer" : ""
                  }`}
                />
              }
              placeholder={null}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <EditorRefPlugin editorRef={editorRef} />
            <EditablePlugin inactive={!!inactive} />
            <SessionMemoryPlugin
              sessionId={sessionId}
              projectEncoded={projectEncoded}
              onEmptyChange={setIsEmpty}
              onBashModeChange={setBashMode}
            />
            <CommandsPlugin sendRef={sendRef} sessionIdRef={sessionRef} />
            <ImagePastePlugin addImageRef={addImageRef} inactive={!!inactive} />
            <FocusPlugin
              autoFocus={!!autoFocus}
              sessionId={sessionId}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            <FileMentionPlugin projectEncoded={projectEncoded} />
            <SkillMentionPlugin projectEncoded={projectEncoded} />
          </LexicalComposer>
        </div>

        {/* Bottom row: attachment chips (left) · ⌘L hint + send (right). */}
        <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {bashMode && (
              <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                bash
              </span>
            )}
            {attachments.map((a) => (
              <div key={a.id} className="group relative">
                <button
                  onClick={() => setPreview(a)}
                  title={a.path ?? "Saving…"}
                  aria-label="Preview image"
                  className="block"
                >
                  <img
                    src={a.previewUrl}
                    alt="attached image"
                    className={`h-11 w-11 rounded-md border border-[var(--border)] object-cover ${
                      a.path === null ? "animate-pulse opacity-50" : ""
                    }`}
                  />
                </button>
                <button
                  onClick={() => removeAttachment(a.id)}
                  aria-label="Remove image"
                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-surface)] text-[10px] leading-none text-[var(--text-secondary)] hover:text-[var(--text)] group-hover:flex"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Hidden (not removed) while focused — no layout shift. */}
            <span
              className={`flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] ${
                focused ? "invisible" : ""
              }`}
            >
              <span>Focus</span>
              <Kbd keys={["⌘", "L"]} />
            </span>
            <button
              onClick={send}
              disabled={!canSend}
              aria-label="Send"
              title={
                notReady
                  ? "Waiting for Claude to finish loading…"
                  : pendingSaves
                    ? "Saving image…"
                    : "Send (⌘↵)"
              }
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>

      {/* Lightweight image preview: overlay + image, click outside to close. */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setPreview(null)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={preview.previewUrl}
              alt="attached image preview"
              className="max-h-[80vh] max-w-[85vw] rounded-lg border border-[var(--border)]"
            />
            <div className="absolute right-2 top-2 flex items-center gap-2">
              <button
                onClick={() => removeAttachment(preview.id)}
                className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--removed-text,#f87171)] transition-colors hover:bg-[var(--bg-surface-hover)]"
              >
                Delete
              </button>
              <button
                onClick={() => setPreview(null)}
                aria-label="Close preview"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] text-[14px] leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

/* ── Lexical plugins (each small + single-purpose) ─────────────────── */

function EditorRefPlugin({
  editorRef,
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      if (editorRef.current === editor) editorRef.current = null;
    };
  }, [editor, editorRef]);
  return null;
}

function EditablePlugin({ inactive }: { inactive: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!inactive);
  }, [editor, inactive]);
  return null;
}

/**
 * Everything this chat's composer remembers: its undo history, the draft it
 * swaps in on a session change, and the debounced persistence of that draft.
 *
 * History and the swap live together on purpose. The swap must not land on the
 * incoming chat's undo stack, which means it has to run after that stack is
 * registered — rendering HistoryPlugin as our own child makes React guarantee
 * that (child effects before parent), instead of it resting on the order two
 * siblings happen to appear in.
 */
function SessionMemoryPlugin({
  sessionId,
  projectEncoded,
  onEmptyChange,
  onBashModeChange,
}: {
  sessionId: string;
  projectEncoded: string;
  onEmptyChange: (empty: boolean) => void;
  onBashModeChange: (bash: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const firstSession = useRef(true);

  // Rebuilt per editor: Lexical's undo() applies a popped entry to the editor
  // named IN that entry, so a stack from a previous mount would drive a dead
  // one and ⌘Z would do nothing.
  const history = useMemo(
    () => takeHistory(editor, sessionId),
    [editor, sessionId],
  );

  useEffect(() => {
    // initialConfig.editorState already loaded the first session's draft; only
    // swap when the session actually changes.
    if (!firstSession.current) {
      const raw = readDraft(sessionId);
      let restored = false;
      if (raw) {
        try {
          editor.setEditorState(editor.parseEditorState(raw), {
            tag: HISTORY_MERGE_TAG,
          });
          onEmptyChange(false);
          restored = true;
        } catch {
          // fall through to a clean slate
        }
      }
      if (!restored) {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode());
          },
          { tag: HISTORY_MERGE_TAG },
        );
        onEmptyChange(true);
      }
    }
    firstSession.current = false;
    // What's on screen is where undo steps back FROM. A swap sets this itself,
    // but a fresh mount takes its draft through initialConfig — before any
    // history listener exists — so the first edit would have nothing to undo to.
    history.current = { editor, editorState: editor.getEditorState() };
    const uncap = editor.registerUpdateListener(() => capHistoryDepth(history));
    return () => {
      uncap();
      saveHistory(sessionId, projectEncoded, history);
    };
  }, [editor, sessionId, projectEncoded, history, onEmptyChange]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unregister = editor.registerUpdateListener(({ editorState }) => {
      const text = editorState.read(() => $getRoot().getTextContent());
      onEmptyChange(text.trim().length === 0);
      onBashModeChange(text.trimStart().startsWith("!"));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (text.trim().length === 0)
          window.localStorage.removeItem(draftKey(sessionId));
        else
          window.localStorage.setItem(
            draftKey(sessionId),
            JSON.stringify(editorState.toJSON()),
          );
      }, 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unregister();
    };
  }, [editor, sessionId, onEmptyChange, onBashModeChange]);

  return <HistoryPlugin externalHistoryState={history} />;
}

/** ⌘Enter→send, Enter→newline, and ⌘Z on an empty box→restore-last-sent. */
function CommandsPlugin({
  sendRef,
  sessionIdRef,
}: {
  sendRef: React.MutableRefObject<() => void>;
  sessionIdRef: React.MutableRefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unEnter = editor.registerCommand<KeyboardEvent | null>(
      KEY_ENTER_COMMAND,
      (e) => {
        // A mention menu is open — let the typeahead handle Enter (select).
        if (isMentionMenuOpen()) return false;
        if (e?.metaKey || e?.ctrlKey) {
          e.preventDefault();
          sendRef.current();
          return true;
        }
        e?.preventDefault();
        editor.update(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) sel.insertLineBreak();
        });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    const unUndo = editor.registerCommand(
      UNDO_COMMAND,
      () => {
        const empty = editor
          .getEditorState()
          .read(() => $getRoot().getTextContent().trim().length === 0);
        if (!empty) return false;
        const sid = sessionIdRef.current;
        const snap = readLastSent(sid);
        if (!snap) return false;
        try {
          editor.setEditorState(editor.parseEditorState(snap));
          clearLastSent(sid);
          return true;
        } catch {
          return false;
        }
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unEnter();
      unUndo();
    };
  }, [editor, sendRef, sessionIdRef]);

  return null;
}

/** Intercept image pastes; let everything else flow to Lexical as plain text. */
function ImagePastePlugin({
  addImageRef,
  inactive,
}: {
  addImageRef: React.MutableRefObject<(file: File, ext: string) => void>;
  inactive: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        if (inactive) return false;
        const items = Array.from(event.clipboardData?.items ?? []).filter(
          (it) => it.type.startsWith("image/"),
        );
        if (items.length === 0) return false; // text paste → Lexical handles it
        event.preventDefault();
        for (const item of items) {
          // Must read synchronously — DataTransferItems die with the event.
          const file = item.getAsFile();
          if (!file) continue;
          const ext = item.type.split("/")[1] || "png";
          addImageRef.current(file, ext);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, inactive, addImageRef]);
  return null;
}

function FocusPlugin({
  autoFocus,
  sessionId,
  onFocus,
  onBlur,
}: {
  autoFocus: boolean;
  sessionId: string;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (autoFocus) editor.focus();
  }, [editor, autoFocus, sessionId]);
  useEffect(() => {
    return editor.registerRootListener((root, prev) => {
      if (prev) {
        prev.removeEventListener("focus", onFocus);
        prev.removeEventListener("blur", onBlur);
      }
      if (root) {
        root.addEventListener("focus", onFocus);
        root.addEventListener("blur", onBlur);
      }
    });
  }, [editor, onFocus, onBlur]);
  return null;
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="6 11 12 5 18 11" />
    </svg>
  );
}
