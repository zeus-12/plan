import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn, sameJson } from "@plan/shared/lib/utils";
import type { ConversationMessage, MessagePart } from "@/common/shared-types";
import { isRealUserTurn } from "./message-kind";

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
  /** Prompts that never reached Claude. Left out of the minimap: it's for
   *  navigating what you actually asked, and an abandoned prompt is usually a
   *  near-duplicate of the one right after it. */
  abortedUuids: Set<string>;
  /** Ref to the transcript's scrollable element (the one holding the rows). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

function previewText(m: ConversationMessage): string {
  const textPart = (
    p: MessagePart,
  ): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text";
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
export function UserMessageOverview({
  messages,
  abortedUuids,
  scrollRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openTimer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef(0);
  const directionRef = useRef<"up" | "down">("down");
  const [maxListHeight, setMaxListHeight] = useState<number>();

  // Identity-stable across streaming ticks: `messages` is a new array every
  // transcript update, but the USER turns rarely change — keeping the old
  // array when content matches means the observer effect below isn't torn
  // down and rebuilt 4×/second while Claude streams.
  const computedUserMessages = useMemo<UserMessage[]>(
    () =>
      messages
        .filter((m) => isRealUserTurn(m) && !abortedUuids.has(m.uuid))
        .map((m) => ({ uuid: m.uuid, text: previewText(m) })),
    [messages, abortedUuids],
  );
  const stableUserMessages = useRef(computedUserMessages);
  if (!sameJson(stableUserMessages.current, computedUserMessages)) {
    stableUserMessages.current = computedUserMessages;
  }
  const userMessages = stableUserMessages.current;

  const uuidSet = useMemo(
    () => new Set(userMessages.map((m) => m.uuid)),
    [userMessages],
  );

  // Highlight the message entering at the leading edge of the scroll: the
  // bottom-most visible turn when scrolling down (and on open), the top-most
  // visible turn when scrolling up. So a sliver peeking in claims the highlight.
  //
  // Visibility is PUSHED by an IntersectionObserver rather than measured per
  // frame — the old scroll handler ran querySelectorAll over every row plus a
  // getBoundingClientRect per user row on every animation frame, layout thrash
  // that grew with transcript length. The scroll listener now only tracks
  // direction (one scrollTop read); picking the highlight is pure iteration
  // over the pushed visibility set. This also stays correct under
  // content-visibility row-height shifts, which the observer re-reports.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userMessages.length === 0) return;
    const visible = new Set<string>();
    let raf = 0;

    // One-time fallback when no user row is on screen and nothing was ever
    // highlighted (opened mid-way through a long assistant stretch): nearest
    // off-screen turn. A single measured pass, not per-frame.
    const nearestOffscreen = () => {
      const containerTop = el.getBoundingClientRect().top;
      let lastAbove: string | null = null;
      let firstBelow: string | null = null;
      for (const row of el.querySelectorAll<HTMLElement>("[data-msg-row]")) {
        const uuid = row.dataset.msgRow;
        if (!uuid || !uuidSet.has(uuid)) continue;
        const r = row.getBoundingClientRect();
        if (r.bottom - containerTop <= VISIBLE_MARGIN_PX) lastAbove = uuid;
        else if (firstBelow === null) firstBelow = uuid;
      }
      return (
        lastAbove ??
        firstBelow ??
        userMessages[userMessages.length - 1]?.uuid ??
        null
      );
    };

    const choose = () => {
      raf = 0;
      let firstVisible: string | null = null;
      let lastVisible: string | null = null;
      for (const m of userMessages) {
        if (!visible.has(m.uuid)) continue;
        if (firstVisible === null) firstVisible = m.uuid;
        lastVisible = m.uuid;
      }
      const chosen = directionRef.current === "up" ? firstVisible : lastVisible;
      // When no user message is on screen (scrolling through a long stretch of
      // assistant/tool output) keep the last highlight — don't snap.
      setActiveUuid((prev) => chosen ?? prev ?? nearestOffscreen());
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(choose);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const uuid = (e.target as HTMLElement).dataset.msgRow;
          if (!uuid) continue;
          if (e.isIntersecting) visible.add(uuid);
          else visible.delete(uuid);
        }
        schedule();
      },
      // The negative margin mirrors VISIBLE_MARGIN_PX: a row counts as visible
      // only once more than a sliver overlaps the viewport.
      { root: el, rootMargin: `-${VISIBLE_MARGIN_PX}px 0px` },
    );
    for (const row of el.querySelectorAll<HTMLElement>("[data-msg-row]")) {
      const uuid = row.dataset.msgRow;
      if (uuid && uuidSet.has(uuid)) io.observe(row);
    }

    const onScroll = () => {
      const st = el.scrollTop;
      if (st > lastScrollTopRef.current + 0.5) directionRef.current = "down";
      else if (st < lastScrollTopRef.current - 0.5) directionRef.current = "up";
      lastScrollTopRef.current = st;
      // Direction flips change which end of the visible set wins, so re-pick
      // even when visibility didn't change. Pure JS — no layout reads.
      schedule();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, userMessages, uuidSet]);

  const scrollTo = useCallback(
    (uuid: string) => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-msg-row="${CSS.escape(uuid)}"]`,
      );
      row?.scrollIntoView({ behavior: "smooth", block: "start" });
      setOpen(false);
    },
    [scrollRef],
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
    const node = listRef.current?.querySelector<HTMLElement>(
      "[data-active='true']",
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(
    () => () => {
      cancelClose();
      cancelOpen();
    },
    [cancelClose, cancelOpen],
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
    count <= 1
      ? 0
      : Math.min(lineCount - 1, Math.floor((idx * lineCount) / count));
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
                    : "bg-[var(--text-tertiary)] opacity-40 group-hover:opacity-70",
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
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]",
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
