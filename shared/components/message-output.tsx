"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Annotation, MessageOptions } from "../lib/store";
import { generateMessage } from "../lib/store";
import { Kbd } from "./ui/kbd";

interface MessageOutputProps {
  annotations: Annotation[];
  options?: MessageOptions;
  onUpdateMessage?: (message: string) => void;
  /**
   * Prebuilt message text. When provided, it overrides the message generated
   * from `annotations` — used when the buffer is assembled from several sources
   * (e.g. diff annotations + chat annotations combined).
   */
  message?: string;
  /** Comment count for the header (defaults to `annotations.length`). */
  count?: number;
  /** When provided, renders a "Send" button that passes the current message. */
  onSend?: (message: string) => void;
  sendLabel?: string;
  /**
   * When true, the send button claims ⌘↵ as a global shortcut and shows the
   * hint on the button — regardless of where focus sits. Text boxes that want
   * their own ⌘↵ (the comment popover, the edit modal) stop the stroke from
   * reaching this listener.
   */
  shortcutEnabled?: boolean;
  /**
   * When provided, renders a "Clear" reset button (top-right). The handler is
   * expected to confirm with the user before discarding the comments.
   */
  onClear?: () => void;
  /**
   * Controlled collapse. When provided, the header chevron reflects and drives
   * this value (and `onToggleCollapse`) instead of the panel's own state — lets
   * a parent minimize/expand it (e.g. auto-minimize on file tabs). Omit both for
   * the default self-managed behaviour.
   */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function MessageOutput({
  annotations,
  options,
  onUpdateMessage,
  message: prebuilt,
  count,
  onSend,
  sendLabel = "Send to terminal",
  shortcutEnabled = false,
  onClear,
  collapsed: controlledCollapsed,
  onToggleCollapse,
}: MessageOutputProps) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const toggleCollapse =
    onToggleCollapse ?? (() => setInternalCollapsed((v) => !v));
  // The full message lives in a modal — easier to read/edit than the short,
  // scrolling inline preview. `null` closed, else the mode it's open in.
  const [modal, setModal] = useState<null | "view" | "edit">(null);
  const [editText, setEditText] = useState("");
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const baseMessage = useMemo(
    () => prebuilt ?? generateMessage(annotations, options),
    [prebuilt, annotations, options],
  );
  const message = customMessage ?? baseMessage;
  const commentCount = count ?? annotations.length;

  // Drop a stale manual edit (and close the modal) when the buffer changes.
  useEffect(() => {
    setCustomMessage(null);
    setModal(null);
  }, [baseMessage]);

  const openEdit = useCallback(() => {
    setEditText(message);
    setModal("edit");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [message]);

  function saveEdit() {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== baseMessage) {
      setCustomMessage(trimmed);
      onUpdateMessage?.(trimmed);
    } else {
      setCustomMessage(null);
    }
    setModal(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setModal(null);
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Stop this stroke from also reaching the panel's window-level ⌘↵ send
      // listener. Closing the modal re-arms that listener, so without cutting
      // propagation here the same keypress would save the edit AND immediately
      // flush the buffer to chat — the edit should settle in the panel first.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      saveEdit();
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const handleSend = useCallback(() => {
    if (!onSend) return;
    onSend(message);
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  }, [onSend, message]);

  // Claim ⌘↵ for the send button while the caller's input box is blurred. We
  // skip it while the modal is open so its own ⌘↵ (save) keeps priority.
  useEffect(() => {
    if (!onSend || !shortcutEnabled || modal) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSend, shortcutEnabled, modal, handleSend]);

  // Close the modal on a bare Escape (when focus isn't in the textarea).
  useEffect(() => {
    if (!modal) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setModal(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modal]);

  if (!baseMessage && !customMessage) return null;

  const ghostBtn =
    "rounded-md px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text)]";
  const iconBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]";

  return (
    <div
      className="rounded-lg border"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
        }}
      >
        <button
          onClick={toggleCollapse}
          className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-xs transition-opacity hover:opacity-70"
          style={{ color: "var(--text-tertiary)" }}
          title={collapsed ? "Show comments" : "Hide comments"}
        >
          <span
            className="inline-block text-[9px] transition-transform"
            style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
          >
            ▼
          </span>
          <span>
            {commentCount} comment
            {commentCount !== 1 ? "s" : ""}
            {customMessage ? " (edited)" : ""}
          </span>
        </button>
        <div className="flex items-center gap-0.5">
          {onClear && (
            <button
              onClick={onClear}
              title="Clear all comments"
              aria-label="Clear all comments"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--removed-text)]"
            >
              <TrashIcon />
            </button>
          )}
          <button
            onClick={() => setModal("view")}
            title="View comments"
            aria-label="View comments"
            className={iconBtn}
          >
            <EyeIcon />
          </button>
          <button
            onClick={openEdit}
            title="Edit comments"
            aria-label="Edit comments"
            className={iconBtn}
          >
            <PencilIcon />
          </button>
          <button
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy to clipboard"}
            aria-label="Copy to clipboard"
            className={iconBtn}
            style={copied ? { color: "var(--diff-add-bar)" } : undefined}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {onSend && (
            <button
              onClick={handleSend}
              className="ml-1 flex items-center gap-1.5 rounded-md px-4 py-1.5 font-[family-name:var(--font-mono)] text-xs font-medium transition-all"
              style={{
                background: sent ? "var(--diff-add-bar)" : "var(--accent)",
                color: sent ? "#fff" : "var(--bg)",
              }}
            >
              {sent ? (
                "Sent ✓"
              ) : (
                <>
                  {sendLabel}
                  {shortcutEnabled && <Kbd keys={["⌘", "↵"]} />}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <pre
          className="max-h-[120px] select-text cursor-pointer overflow-y-auto whitespace-pre-wrap p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed transition-colors hover:bg-[var(--bg-surface-hover)]"
          style={{ color: "var(--text-secondary)" }}
          onDoubleClick={openEdit}
          title="Double-click to edit"
        >
          {message}
        </pre>
      )}

      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onMouseDown={() => setModal(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-[720px] flex-col rounded-xl border shadow-2xl"
            style={{
              background: "var(--bg-surface)",
              borderColor: "var(--border)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <span
                className="font-[family-name:var(--font-mono)] text-xs"
                style={{ color: "var(--text-tertiary)" }}
              >
                {modal === "edit" ? "Editing comments" : "Comments"}
                {" · "}
                {commentCount} comment{commentCount !== 1 ? "s" : ""}
              </span>
              <div className="flex items-center gap-1">
                {modal === "view" && (
                  <button onClick={openEdit} className={ghostBtn}>
                    Edit
                  </button>
                )}
                <button
                  onClick={() => setModal(null)}
                  aria-label="Close"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[14px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
                >
                  ×
                </button>
              </div>
            </div>

            {modal === "edit" ? (
              <div className="flex min-h-0 flex-1 flex-col p-3">
                <textarea
                  ref={textareaRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="min-h-0 flex-1 resize-none rounded-md border p-3 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
                  style={{
                    background: "var(--bg)",
                    borderColor: "var(--border)",
                    color: "var(--text)",
                    minHeight: 240,
                  }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span
                    className="text-[10px]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    ⌘ Enter to save, Esc to cancel
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setModal(null)}
                      className="text-xs"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveEdit}
                      className="rounded-md px-3 py-1 text-xs font-medium"
                      style={{
                        background: "var(--accent)",
                        color: "var(--bg)",
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <pre
                className="min-h-0 flex-1 select-text overflow-y-auto whitespace-pre-wrap p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed"
                style={{ color: "var(--text)" }}
              >
                {message}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline 14px icons (Lucide path data) for the header actions. Hand-rolled like
 * `find-widget.tsx` so `shared/` stays free of an icon-library dependency — it's
 * consumed by both the desktop and web apps, and only one of them ships Lucide.
 */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function EyeIcon() {
  return (
    <Icon>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function PencilIcon() {
  return (
    <Icon>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.986L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z" />
      <path d="m15 5 4 4" />
    </Icon>
  );
}

function CopyIcon() {
  return (
    <Icon>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

function CheckIcon() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </Icon>
  );
}
