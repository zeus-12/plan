import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Kbd } from "@plan/shared/components/ui/kbd";

export interface ChatInputHandle {
  focus: () => void;
  /** Append text to the draft (used by "Add to chat"). */
  append: (text: string) => void;
}

interface Props {
  /** Session this composer belongs to — keys the persisted draft. */
  sessionId: string;
  onSend: (text: string) => void;
  /** No live terminal yet — clicking the box starts one (see onStart). */
  inactive?: boolean;
  onStart?: () => void;
  /** Focus the textarea when this session becomes the composer's session. */
  autoFocus?: boolean;
}

interface Attachment {
  id: string;
  /** Object URL of the pasted blob — shows instantly. */
  previewUrl: string;
  /** Temp-file path once saved; null while the background save is running. */
  path: string | null;
}

const MIN_HEIGHT = 72;
const MAX_HEIGHT = 260;
const draftKey = (sid: string) => `plan.draft.${sid}`;

/**
 * Message composer. Enter sends, Shift+Enter inserts a newline.
 *
 * The text state lives HERE, not in the workspace — so a keystroke re-renders
 * only this small component instead of the whole project tree. Drafts persist
 * per session with debounced localStorage writes.
 *
 * Pasted images appear as chips instantly (the preview is the pasted blob);
 * the temp-file save runs in the background and Send stays disabled until
 * every attachment has a real path — the paths are what actually get sent.
 */
export const ChatInput = forwardRef<ChatInputHandle, Props>(
  function ChatInput({ sessionId, onSend, inactive, onStart, autoFocus }, ref) {
    const [value, setValue] = useState(
      () => window.localStorage.getItem(draftKey(sessionId)) ?? ""
    );
    const [focused, setFocused] = useState(false);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [preview, setPreview] = useState<Attachment | null>(null);
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearAttachments = () => {
      setAttachments((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
        return [];
      });
      setPreview(null);
    };

    // Attachments belong to one conversation — drop them on session switch
    // and on unmount (revoking the preview object URLs).
    useEffect(() => clearAttachments, [sessionId]);

    // Swap drafts when the session changes.
    useEffect(() => {
      setValue(window.localStorage.getItem(draftKey(sessionId)) ?? "");
    }, [sessionId]);

    // Focus on session swap when asked (e.g. a brand-new chat) — driven by the
    // commit lifecycle, not a rAF race against React's render.
    useEffect(() => {
      if (autoFocus) innerRef.current?.focus();
    }, [sessionId, autoFocus]);

    // Debounced draft persistence.
    useEffect(() => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (value) window.localStorage.setItem(draftKey(sessionId), value);
        else window.localStorage.removeItem(draftKey(sessionId));
      }, 300);
      return () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
      };
    }, [value, sessionId]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => innerRef.current?.focus(),
        append: (text: string) =>
          setValue((prev) => (prev.trim() ? `${prev}\n\n${text}` : text)),
      }),
      []
    );

    // Auto-size to content within [MIN_HEIGHT, MAX_HEIGHT].
    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(
        Math.max(el.scrollHeight, MIN_HEIGHT),
        MAX_HEIGHT
      )}px`;
    }, [value]);

    const removeAttachment = (id: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.id === id);
        if (target) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((a) => a.id !== id);
      });
      setPreview((p) => (p?.id === id ? null : p));
    };

    const pendingSaves = attachments.some((a) => a.path === null);
    const canSend =
      !inactive &&
      !pendingSaves &&
      (value.trim().length > 0 || attachments.length > 0);

    const send = () => {
      if (inactive || pendingSaves) return;
      const text = value.trim();
      const paths = attachments
        .map((a) => a.path)
        .filter((p): p is string => p !== null)
        .join(" ");
      const full = [text, paths].filter(Boolean).join("\n\n");
      if (!full) return;
      onSend(full);
      setValue("");
      clearAttachments();
      window.localStorage.removeItem(draftKey(sessionId));
    };

    // Pasted images: chip appears IMMEDIATELY (object URL of the blob); the
    // temp-file write happens in the background. Text pastes are untouched.
    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (inactive) return;
      const images = Array.from(e.clipboardData?.items ?? []).filter((it) =>
        it.type.startsWith("image/")
      );
      if (images.length === 0) return;
      e.preventDefault();
      for (const item of images) {
        // Must be read synchronously — DataTransferItems die with the event.
        const file = item.getAsFile();
        if (!file) continue;
        const ext = item.type.split("/")[1] || "png";
        const id = crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        setAttachments((prev) => [...prev, { id, previewUrl, path: null }]);
        void (async () => {
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            const path = await window.electronAPI.saveTempImage(buf, ext);
            if (path) {
              setAttachments((prev) =>
                prev.map((a) => (a.id === id ? { ...a, path } : a))
              );
            } else {
              removeAttachment(id);
            }
          } catch {
            removeAttachment(id);
          }
        })();
      }
    };

    return (
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-surface)] p-3">
        <div className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--bg)] transition-colors focus-within:border-[var(--border-strong)]">
          <textarea
            ref={innerRef}
            value={value}
            readOnly={inactive}
            placeholder={
              inactive
                ? "Click here to connect this chat to Claude…"
                : "What would you like to make?"
            }
            onClick={inactive ? onStart : undefined}
            onChange={(e) => setValue(e.target.value)}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
            className={`w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)] ${
              inactive ? "cursor-pointer" : ""
            }`}
          />
          {/* Bottom row: attachment chips (left) · ⌘L hint + send (right). */}
          <div className="flex items-end justify-between gap-2 px-2 pb-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
                title={pendingSaves ? "Saving image…" : "Send (Enter)"}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-40"
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
  }
);

function SendIcon() {
  return (
    <svg
      width="15"
      height="15"
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
