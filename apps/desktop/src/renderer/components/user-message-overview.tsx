import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@plan/shared/lib/utils";
import type { ConversationMessage, MessagePart } from "../../shared-types";

/** How many px of a message must be on screen before it counts as "visible"
 *  for the position highlight — small, so a sliver peeking in at the leading
 *  edge already claims the highlight. */
const VISIBLE_MARGIN_PX = 8;

/** Upper bound on minimap lines. Past this the lines bucket several messages
 *  each so the strip never grows taller than the pane (500-message sessions
 *  collapse to 56 evenly-sampled markers instead of an endless column). */
const MAX_LINES = 56;

interface UserMessage {
  uuid: string;
  text: string;
}

interface Props {
  /** The full (filtered) timeline — we pick the real user turns out of it. */
  messages: ConversationMessage[];
  /** Ref to the transcript's scrollable element (the one holding the rows). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

function isUserTurn(m: ConversationMessage): boolean {
  if (m.role !== "user") return false;
  // A turn that's only tool_results isn't a real user message.
  return m.parts.some((p) => p.kind !== "tool_result");
}

function previewText(m: ConversationMessage): string {
  const textPart = (p: MessagePart): p is Extract<MessagePart, { kind: "text" }> =>
    p.kind === "text";
  const text = m.parts
    .filter(textPart)
    .map((p) => p.text)
    .join(" ")
    // Strip the slash-command / wrapper tags Claude Code injects so the preview
    // reads like what the user typed.
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "(no text)";
}

/**
 * A minimap of the session's user messages, pinned to the top-right of the
 * transcript: one line per message, the one you're currently scrolled to
 * highlighted. Hovering reveals the messages as text; clicking a line (or a
 * row) scrolls that message into view.
 */
export function UserMessageOverview({ messages, scrollRef }: Props) {
  const [open, setOpen] = useState(false);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const directionRef = useRef<"up" | "down">("down");
  const [maxListHeight, setMaxListHeight] = useState<number>();

  const userMessages = useMemo<UserMessage[]>(
    () =>
      messages
        .filter(isUserTurn)
        .map((m) => ({ uuid: m.uuid, text: previewText(m) })),
    [messages]
  );

  const uuidSet = useMemo(
    () => new Set(userMessages.map((m) => m.uuid)),
    [userMessages]
  );

  // Highlight the message entering at the leading edge of the scroll: the
  // bottom-most visible turn when scrolling down (and on open), the top-most
  // visible turn when scrolling up. So a sliver peeking in claims the highlight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userMessages.length === 0) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const st = el.scrollTop;
      if (st > lastScrollTopRef.current + 0.5) directionRef.current = "down";
      else if (st < lastScrollTopRef.current - 0.5) directionRef.current = "up";
      lastScrollTopRef.current = st;

      const containerTop = el.getBoundingClientRect().top;
      const viewHeight = el.clientHeight;
      let firstVisible: string | null = null;
      let lastVisible: string | null = null;
      // For the very first pick (no prior highlight): the nearest user message
      // off-screen — the last one above the viewport, else the first below.
      let lastAbove: string | null = null;
      let firstBelow: string | null = null;
      const rows = el.querySelectorAll<HTMLElement>("[data-msg-row]");
      for (const row of rows) {
        const uuid = row.dataset.msgRow;
        if (!uuid || !uuidSet.has(uuid)) continue;
        const r = row.getBoundingClientRect();
        const top = r.top - containerTop;
        const bottom = r.bottom - containerTop;
        const visible =
          bottom > VISIBLE_MARGIN_PX && top < viewHeight - VISIBLE_MARGIN_PX;
        if (visible) {
          if (firstVisible === null) firstVisible = uuid;
          lastVisible = uuid;
        } else if (bottom <= VISIBLE_MARGIN_PX) {
          lastAbove = uuid;
        } else if (firstBelow === null) {
          firstBelow = uuid;
        }
      }
      const chosen =
        directionRef.current === "up" ? firstVisible : lastVisible;
      // Nearest off-screen turn, falling back to the bottom-most message.
      const nearest =
        lastAbove ?? firstBelow ?? userMessages[userMessages.length - 1]?.uuid ?? null;
      // When no user message is on screen (scrolling through a long stretch of
      // assistant/tool output) keep the last highlight — don't snap.
      setActiveUuid((prev) => chosen ?? prev ?? nearest);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, userMessages, uuidSet]);

  const scrollTo = useCallback(
    (uuid: string) => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-msg-row="${CSS.escape(uuid)}"]`
      );
      row?.scrollIntoView({ behavior: "smooth", block: "start" });
      setOpen(false);
    },
    [scrollRef]
  );

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);

  // Require the cursor to dwell on the strip before revealing the popover, so a
  // quick pass-through (e.g. moving from the chat to the side tab) doesn't
  // trigger it. An already-open popover reopens instantly.
  const scheduleOpen = useCallback(() => {
    cancelOpen();
    if (open) {
      setOpen(true);
      return;
    }
    openTimer.current = window.setTimeout(() => setOpen(true), 220);
  }, [cancelOpen, open]);

  // Cap the popover to the space between the strip and the bottom of the
  // viewport so a long list scrolls internally instead of spilling past the
  // window and scrolling the whole app. Recompute on open and on resize.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      // Popover opens to the left, top-aligned with the strip.
      setMaxListHeight(Math.max(120, window.innerHeight - r.top - 12));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Bring the active item into view whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    node?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(
    () => () => {
      cancelClose();
      cancelOpen();
    },
    [cancelClose, cancelOpen]
  );

  const count = userMessages.length;
  const activeIndex = useMemo(() => {
    if (!activeUuid) return 0;
    const i = userMessages.findIndex((m) => m.uuid === activeUuid);
    return i < 0 ? 0 : i;
  }, [activeUuid, userMessages]);

  // Map messages → minimap lines. Below MAX_LINES it's 1:1; above it, each line
  // stands for a contiguous bucket of messages (and a click lands on the first
  // message in that bucket).
  const lineCount = Math.min(count, MAX_LINES);
  const lineForIndex = (idx: number) =>
    count <= 1 ? 0 : Math.min(lineCount - 1, Math.floor((idx * lineCount) / count));
  const indexForLine = (line: number) => Math.floor((line * count) / lineCount);
  const activeLine = lineForIndex(activeIndex);

  if (count === 0) return null;

  return (
    <div
      ref={wrapRef}
      className="absolute right-3 top-3 z-20"
      onMouseEnter={() => {
        cancelClose();
        scheduleOpen();
      }}
      onMouseLeave={() => {
        cancelOpen();
        scheduleClose();
      }}
    >
      {/* Collapsed minimap: one equal-width line per message. */}
      <div className="flex w-[26px] flex-col items-stretch gap-[3px] rounded-md p-1.5">
        {Array.from({ length: lineCount }, (_, line) => {
          const active = line === activeLine;
          return (
            <button
              key={line}
              type="button"
              aria-label="Jump to message"
              onClick={() => scrollTo(userMessages[indexForLine(line)]!.uuid)}
              className="group flex h-[3px] items-center"
            >
              <span
                className={cn(
                  "h-[2px] w-full rounded-full transition-[background-color,opacity] duration-200 ease-out",
                  active
                    ? "bg-[var(--accent)]"
                    : "bg-[var(--text-tertiary)] opacity-40 group-hover:opacity-70"
                )}
              />
            </button>
          );
        })}
      </div>

      {open && (
        <div
          ref={listRef}
          style={{ maxHeight: maxListHeight }}
          className="absolute right-full top-0 mr-2 w-[300px] overflow-y-auto rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-xl"
        >
          {userMessages.map((m) => {
            const active = m.uuid === activeUuid;
            return (
              <button
                key={m.uuid}
                type="button"
                data-active={active}
                onClick={() => scrollTo(m.uuid)}
                className={cn(
                  "block w-full truncate rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                  active
                    ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]"
                )}
              >
                {m.text}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
