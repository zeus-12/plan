import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Copy,
  ListOrdered,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@plan/shared/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@plan/shared/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plan/shared/components/ui/dropdown-menu";
import type { SessionNote } from "@/common/shared-types";
import { pushToast } from "@/renderer/lib/toast-store";
import { formatNotes, formatNotesAsList } from "./notes-format";
import {
  addNote,
  mergeNotes,
  reloadNotes,
  removeNotes,
  setNotesDone,
  updateNoteText,
  useNotesStatus,
  useSessionNotes,
} from "./notes-store";

interface Props {
  /** Project encoded dir — the stash's storage key. */
  encoded: string;
  /** The chat these notes belong to; null when no chat is selected. */
  sessionId: string | null;
  /** Whether the pane is on screen (gates focus + the capture flash). */
  visible: boolean;
  /** Bumped to pull focus into the composer (the capture shortcut does this). */
  focusSignal: number;
  /** Drop text into the chat composer. Absent when there's no chat to drop into. */
  onInsertToChat?: (text: string) => void;
}

const COMPOSER_MAX_HEIGHT = 132;

/** A textarea that grows with its content up to a cap, then scrolls. */
function useAutoGrow(value: string, max: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value, max]);
  return ref;
}

function DoneCircle({
  done,
  onToggle,
  label,
}: {
  done: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={label}
      aria-label={label}
      aria-pressed={done}
      className={cn(
        "mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors",
        done
          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]"
          : "border-[var(--border-strong)] text-transparent hover:border-[var(--text-tertiary)]",
      )}
    >
      <Check size={10} strokeWidth={3} />
    </button>
  );
}

function NoteCard({
  note,
  selected,
  editing,
  onSelect,
  onToggleDone,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  menu,
}: {
  note: SessionNote;
  selected: boolean;
  editing: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onToggleDone: () => void;
  onStartEdit: () => void;
  onCommitEdit: (text: string) => void;
  onCancelEdit: () => void;
  menu: React.ReactNode;
}) {
  const [draft, setDraft] = useState(note.text);
  const ref = useAutoGrow(draft, 260);
  // Cancelling unmounts the textarea, which can still fire blur on the way out —
  // without this the discarded draft would be committed by that blur.
  const skipBlur = useRef(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(note.text);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing, note.text, ref]);

  const card = (
    <div
      data-note-card
      onClick={onSelect}
      onDoubleClick={onStartEdit}
      className={cn(
        "flex cursor-default gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
        selected
          ? "border-[color-mix(in_srgb,var(--accent)_60%,var(--border-strong))] bg-[var(--row-selected)]"
          : "border-transparent bg-[var(--bg-surface-hover)] hover:border-[var(--border-strong)]",
        // Done notes recede as a whole, so the state reads even at a glance —
        // the strikethrough alone is easy to miss on a short note.
        note.done && "opacity-60",
      )}
    >
      <DoneCircle
        done={note.done}
        onToggle={onToggleDone}
        label={note.done ? "Mark as not done" : "Mark as done"}
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={ref}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (skipBlur.current) {
                skipBlur.current = false;
                return;
              }
              onCommitEdit(draft);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                skipBlur.current = true;
                onCancelEdit();
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onCommitEdit(draft);
              }
            }}
            className="w-full resize-none overflow-y-auto bg-transparent text-[12px] leading-[1.55] text-[var(--text)] outline-none"
          />
        ) : (
          <p
            data-note-text
            className={cn(
              "line-clamp-4 whitespace-pre-wrap break-words text-[12px] leading-[1.55]",
              note.done
                ? "text-[var(--text-tertiary)] line-through"
                : "text-[var(--text)]",
            )}
          >
            {note.text}
          </p>
        )}
        {note.source && !editing && (
          <span
            data-note-source
            className="mt-1 block truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]"
          >
            {note.source}
          </span>
        )}
      </div>
    </div>
  );

  // An editing card keeps its own key handling; wrapping it in the menu trigger
  // would let a right-click inside the textarea replace the caret menu.
  if (editing) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}

/**
 * The per-chat note stash: a place to park a thought — a prompt you're not ready
 * to send, a snippet you captured off the transcript — and later select several,
 * copy them as a numbered list, and paste them into the chat.
 *
 * Notes are scoped to the selected chat (see notes-store), so switching chats
 * swaps the list. Everything shown here is stored state: nothing is inferred,
 * and a note only leaves the list when you mark it done or delete it.
 */
export function NotesPanel({
  encoded,
  sessionId,
  visible,
  focusSignal,
  onInsertToChat,
}: Props) {
  const notes = useSessionNotes(encoded, sessionId);
  const notesStatus = useNotesStatus(encoded);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useAutoGrow(draft, COMPOSER_MAX_HEIGHT);
  // Anchor for shift-click ranges — the last card clicked without shift.
  const anchorRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.text.toLowerCase().includes(q));
  }, [notes, query]);

  const open = filtered.filter((n) => !n.done);
  const done = filtered.filter((n) => n.done);
  // Ordered as the list shows them, so a copy reads top-to-bottom.
  const ordered = [...open, ...done];

  // Selection is ids; a note deleted elsewhere must not linger in it.
  useEffect(() => {
    setSelected((prev) => {
      const live = prev.filter((id) => notes.some((n) => n.id === id));
      return live.length === prev.length ? prev : live;
    });
  }, [notes]);

  // Switching chats swaps the whole list — carry nothing over.
  useEffect(() => {
    setSelected([]);
    setEditingId(null);
    setQuery("");
  }, [sessionId]);

  const selectedNotes = ordered.filter((n) => selected.includes(n.id));

  useEffect(() => {
    if (!visible || focusSignal === 0) return;
    composerRef.current?.focus();
  }, [focusSignal, visible, composerRef]);

  const copy = useCallback(async (text: string, title: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    pushToast({ title, id: "notes-copy" }, 2000);
  }, []);

  const handleSelect = (note: SessionNote, e: React.MouseEvent) => {
    rootRef.current?.focus();
    if (e.metaKey || e.ctrlKey) {
      anchorRef.current = note.id;
      setSelected((prev) =>
        prev.includes(note.id)
          ? prev.filter((id) => id !== note.id)
          : [...prev, note.id],
      );
      return;
    }
    if (e.shiftKey && anchorRef.current) {
      const from = ordered.findIndex((n) => n.id === anchorRef.current);
      const to = ordered.findIndex((n) => n.id === note.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(ordered.slice(lo, hi + 1).map((n) => n.id));
        return;
      }
    }
    anchorRef.current = note.id;
    setSelected((prev) =>
      prev.length === 1 && prev[0] === note.id ? [] : [note.id],
    );
  };

  const submitDraft = async () => {
    if (!sessionId) return;
    const text = draft;
    setDraft("");
    await addNote(encoded, sessionId, text);
  };

  const copySelected = (asList: boolean) => {
    const picked = selectedNotes;
    if (picked.length === 0) return;
    void copy(
      asList ? formatNotesAsList(picked) : formatNotes(picked),
      asList ? "Copied as list" : "Copied",
    );
  };

  const insertSelected = () => {
    const picked = selectedNotes;
    if (picked.length === 0 || !onInsertToChat) return;
    onInsertToChat(
      picked.length > 1 ? formatNotesAsList(picked) : formatNotes(picked),
    );
    setSelected([]);
  };

  const toggleDoneSelected = () => {
    if (!sessionId || selectedNotes.length === 0) return;
    // One note's state can't decide the batch's: flip everything to the
    // opposite of "are they all done already".
    const allDone = selectedNotes.every((n) => n.done);
    void setNotesDone(
      encoded,
      sessionId,
      selectedNotes.map((n) => n.id),
      !allDone,
    );
  };

  const deleteSelected = () => {
    if (!sessionId || selected.length === 0) return;
    void removeNotes(encoded, sessionId, selected);
    setSelected([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      setSelected([]);
      return;
    }
    if (selected.length === 0) return;
    if (meta && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelected(e.shiftKey);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      toggleDoneSelected();
      return;
    }
    if (e.key === "Enter" && selected.length === 1) {
      e.preventDefault();
      setEditingId(selected[0]);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      deleteSelected();
    }
  };

  const noteMenu = (note: SessionNote) => {
    // Right-clicking outside the current selection acts on that note alone —
    // matching every list in the app, and never silently on a hidden batch.
    const targets = selected.includes(note.id) ? selectedNotes : [note];
    const ids = targets.map((n) => n.id);
    const allDone = targets.every((n) => n.done);
    return (
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => void copy(formatNotes(targets), "Copied")}
        >
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void copy(formatNotesAsList(targets), "Copied as list")
          }
        >
          Copy as list
          <ContextMenuShortcut>⇧⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        {onInsertToChat && (
          <ContextMenuItem
            onSelect={() => {
              onInsertToChat(
                targets.length > 1
                  ? formatNotesAsList(targets)
                  : formatNotes(targets),
              );
              setSelected([]);
            }}
          >
            Add to composer
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            sessionId && void setNotesDone(encoded, sessionId, ids, !allDone)
          }
        >
          {allDone ? "Mark as not done" : "Mark as done"}
          <ContextMenuShortcut>Space</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={targets.length !== 1}
          onSelect={() => setEditingId(note.id)}
        >
          Edit
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={targets.length < 2}
          onSelect={() => {
            if (!sessionId) return;
            void mergeNotes(encoded, sessionId, ids);
            setSelected([ids[0]]);
          }}
        >
          Merge notes
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          destructive
          onSelect={() => {
            if (!sessionId) return;
            void removeNotes(encoded, sessionId, ids);
            setSelected([]);
          }}
        >
          Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    );
  };

  // One file holds every chat's notes, so an unreadable stash is a hard stop,
  // not an empty list: the store refuses edits until a re-read succeeds, and
  // showing "no notes" here would be a lie about what's on disk.
  if (notesStatus.kind === "unreadable") {
    return (
      <div
        data-notes-panel
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <p className="font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--removed-text)]">
          Couldn't read this project's notes, so they're locked to keep the file
          intact.
        </p>
        <p className="max-w-full truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {notesStatus.error}
        </p>
        <button
          onClick={() => void reloadNotes(encoded)}
          className="rounded border border-[var(--border-strong)] px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div
        data-notes-panel
        className="flex h-full items-center justify-center px-6 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]"
      >
        Notes belong to a chat — pick one to start a stash.
      </div>
    );
  }

  const hasSelection = selected.length > 0;

  return (
    <div
      data-notes-panel
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex h-full flex-col outline-none"
    >
      {/* Header: search, or the batch actions once something is selected. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-2">
        {hasSelection ? (
          <>
            {/* Icons, not words: the sidebar narrows to 220px, where a row of
                worded buttons wrapped onto a second line and broke the row. */}
            <span className="min-w-0 shrink truncate pl-1 font-[family-name:var(--font-mono)] text-[11px] whitespace-nowrap text-[var(--text-secondary)]">
              {selected.length} selected
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <HeaderAction
                label="Copy as list (⇧⌘C)"
                onClick={() => copySelected(true)}
              >
                <ListOrdered size={14} />
              </HeaderAction>
              <HeaderAction
                label="Copy (⌘C)"
                onClick={() => copySelected(false)}
              >
                <Copy size={13} />
              </HeaderAction>
              {onInsertToChat && (
                <HeaderAction
                  label="Add to chat composer"
                  onClick={insertSelected}
                >
                  <MessageSquarePlus size={14} />
                </HeaderAction>
              )}
              <HeaderAction label="Delete (⌫)" onClick={deleteSelected}>
                <Trash2 size={13} />
              </HeaderAction>
              <HeaderAction
                label="Clear selection (Esc)"
                onClick={() => setSelected([])}
              >
                <X size={14} />
              </HeaderAction>
            </div>
          </>
        ) : (
          <>
            <div className="relative min-w-0 flex-1">
              <Search
                size={12}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                spellCheck={false}
                className="h-6 w-full rounded-md bg-[var(--bg-surface-hover)] pl-6 pr-2 text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Notes actions"
                  aria-label="Notes actions"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={ordered.length === 0}
                  onSelect={() =>
                    void copy(formatNotesAsList(ordered), "Copied as list")
                  }
                >
                  Copy all as list
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={open.length === 0}
                  onSelect={() => setSelected(open.map((n) => n.id))}
                >
                  Select all open
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  disabled={done.length === 0}
                  onSelect={() =>
                    void removeNotes(
                      encoded,
                      sessionId,
                      done.map((n) => n.id),
                    )
                  }
                >
                  Delete done notes
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {ordered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            {notes.length === 0
              ? "Nothing stashed yet. Type below, or select text anywhere and double-tap ⇧."
              : "No notes match that search."}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {open.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                selected={selected.includes(n.id)}
                editing={editingId === n.id}
                onSelect={(e) => handleSelect(n, e)}
                onToggleDone={() =>
                  void setNotesDone(encoded, sessionId, [n.id], true)
                }
                onStartEdit={() => setEditingId(n.id)}
                onCommitEdit={(text) => {
                  setEditingId(null);
                  if (text !== n.text)
                    void updateNoteText(encoded, sessionId, n.id, text);
                }}
                onCancelEdit={() => setEditingId(null)}
                menu={noteMenu(n)}
              />
            ))}

            {done.length > 0 && (
              <div className="flex items-center gap-2 px-1 pb-0.5 pt-3">
                <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  Done
                </span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>
            )}
            {done.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                selected={selected.includes(n.id)}
                editing={editingId === n.id}
                onSelect={(e) => handleSelect(n, e)}
                onToggleDone={() =>
                  void setNotesDone(encoded, sessionId, [n.id], false)
                }
                onStartEdit={() => setEditingId(n.id)}
                onCommitEdit={(text) => {
                  setEditingId(null);
                  if (text !== n.text)
                    void updateNoteText(encoded, sessionId, n.id, text);
                }}
                onCancelEdit={() => setEditingId(null)}
                menu={noteMenu(n)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Composer — the same card shape as a note, so adding one reads as
          writing the row that's about to appear above it. */}
      <div className="shrink-0 px-2 pb-2">
        <div className="flex gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-hover)] px-2.5 py-2 focus-within:border-[var(--border-strong)]">
          <span className="mt-[1px] h-[15px] w-[15px] shrink-0 rounded-full border border-[var(--border-strong)]" />
          <textarea
            data-notes-composer
            ref={composerRef}
            value={draft}
            rows={1}
            spellCheck={false}
            placeholder="Add a note or a prompt"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitDraft();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
            className="w-full resize-none overflow-y-auto bg-transparent text-[12px] leading-[1.55] text-[var(--text)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
        </div>
      </div>
    </div>
  );
}

function HeaderAction({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}
