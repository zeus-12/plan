import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameJson } from "@plan/shared/lib/utils";
import type { ConversationMessage, MessagePart } from "@/common/shared-types";
import { isRealUserTurn } from "./message-kind";

/** How many px of a message must be on screen before it counts as "visible"
 *  for the position highlight — small, so a sliver peeking in at the leading
 *  edge already claims the highlight. */
const VISIBLE_MARGIN_PX = 8;

/** Tick pitch. The rail shrinks to fit the pane before it buckets, so a
 *  typical session keeps one tick per message and only a very long one
 *  collapses several messages onto a tick. */
const MAX_PITCH_PX = 14;
const MIN_PITCH_PX = 4;

/** Inset of the rail from the top and bottom of the pane. */
const RAIL_INSET_PX = 12;

const CARD_HEIGHT_PX = 80;
const PROMPT_LIMIT = 120;
const REPLY_LIMIT = 200;

interface UserMessage {
  uuid: string;
  text: string;
}

interface Props {
  /** The full (filtered) timeline — we pick the real user turns out of it. */
  messages: ConversationMessage[];
  /** Prompts that never reached Claude. Left out of the rail: it's for
   *  navigating what you actually asked, and an abandoned prompt is usually a
   *  near-duplicate of the one right after it. */
  abortedUuids: Set<string>;
  /** Ref to the transcript's scrollable element (the one holding the rows). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Jumps to a message and holds it there while the rows around it render. */
  onJump: (uuid: string) => void;
}

function plainText(m: ConversationMessage, limit: number): string {
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
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
}

/**
 * A rail of the session's user messages, pinned to the right of the transcript:
 * one tick per message, the one you're scrolled to marked by the accent bar.
 * The ticks widen towards the pointer and hovering one reveals a card with the
 * prompt and the reply it got; clicking jumps there.
 *
 * Tick width and the card's travel are driven by two CSS variables on the rail
 * (`--h`, the focus line, and each tick's own `--i`), written imperatively.
 * Hover therefore mutates one inline style instead of re-rendering ~190 ticks
 * per pointer move, which is what makes the pyramid cheap enough to run on
 * every frame of a scrub.
 */
export function MessageRail({
  messages,
  abortedUuids,
  scrollRef,
  onJump,
}: Props) {
  const [activeUuid, setActiveUuid] = useState<string | null>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [availH, setAvailH] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const railRectRef = useRef<DOMRect | null>(null);
  const lastScrollTopRef = useRef(0);
  const directionRef = useRef<"up" | "down">("down");
  // Kept so the card can fade out where it last stood instead of sliding back
  // to the top on the way out.
  const restLineRef = useRef(0);

  // Identity-stable across streaming ticks: `messages` is a new array every
  // transcript update, but the USER turns rarely change — keeping the old
  // array when content matches means the observer effect below isn't torn
  // down and rebuilt 4×/second while Claude streams.
  const computedUserMessages = useMemo<UserMessage[]>(
    () =>
      messages
        .filter((m) => isRealUserTurn(m) && !abortedUuids.has(m.uuid))
        .map((m) => ({ uuid: m.uuid, text: plainText(m, PROMPT_LIMIT) })),
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
    /** The rail's rows in document order, for the bracket search below. */
    const userRows: HTMLElement[] = [];
    let raf = 0;

    /**
     * The turns immediately above and below the viewport.
     *
     * Binary search, because the rows are in document order: ~8 rect reads
     * rather than one per turn. It runs only when nothing is on screen, so an
     * ordinary scroll never pays for it at all.
     */
    const bracket = () => {
      const containerTop = el.getBoundingClientRect().top;
      const isAbove = (i: number) =>
        userRows[i]!.getBoundingClientRect().bottom - containerTop <=
        VISIBLE_MARGIN_PX;
      let lo = 0;
      let hi = userRows.length - 1;
      let last = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (isAbove(mid)) {
          last = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return {
        above: last >= 0 ? userRows[last]!.dataset.msgRow : undefined,
        below: userRows[last + 1]?.dataset.msgRow,
      };
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
      if (chosen) {
        setActiveUuid(chosen);
        return;
      }
      // Nothing on screen: the reader is inside one long answer. Keep the
      // highlight while it is still the turn on one side of the viewport —
      // that is the case worth not snapping. A jump lands with it on neither
      // side, and keeping it there left "Scroll to latest" marking wherever
      // the reader came from.
      setActiveUuid((prev) => {
        const { above, below } = bracket();
        if (prev && (prev === above || prev === below)) return prev;
        return (
          above ?? below ?? userMessages[userMessages.length - 1]?.uuid ?? null
        );
      });
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
      if (!uuid || !uuidSet.has(uuid)) continue;
      userRows.push(row);
      io.observe(row);
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

  // The rail spans the pane, so its height decides how many ticks fit.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setAvailH(Math.max(0, el.clientHeight - 2 * RAIL_INSET_PX));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  // Not scrollIntoView: rows outside the render window sit at an estimated
  // offset, so a one-shot jump lands near the target and then slides as the
  // real heights arrive. The transcript owns the correction.
  const scrollTo = useCallback((uuid: string) => onJump(uuid), [onJump]);

  const count = userMessages.length;
  const activeIndex = useMemo(() => {
    if (!activeUuid) return 0;
    const i = userMessages.findIndex((m) => m.uuid === activeUuid);
    return i < 0 ? 0 : i;
  }, [activeUuid, userMessages]);

  // Map messages → rail lines. The pitch shrinks to fit the pane first; only
  // once it hits the floor do lines start standing for several messages each
  // (and a click then lands on the first message of that bucket).
  const maxLines = Math.max(1, Math.floor(availH / MIN_PITCH_PX));
  const lineCount = Math.max(1, Math.min(count, maxLines));
  const pitch = Math.min(
    MAX_PITCH_PX,
    Math.max(MIN_PITCH_PX, Math.floor(availH / lineCount)),
  );
  const lineForIndex = (idx: number) =>
    count <= 1
      ? 0
      : Math.min(lineCount - 1, Math.floor((idx * lineCount) / count));
  const indexForLine = (line: number) =>
    Math.min(count - 1, Math.floor((line * count) / lineCount));
  const activeLine = lineForIndex(activeIndex);

  // One inline write per pointer move, instead of re-rendering every tick.
  // Falls back to the active line so the pyramid always marks where you are.
  const focusLine = hoverLine ?? activeLine;
  useEffect(() => {
    railRef.current?.style.setProperty("--h", String(focusLine));
    if (hoverLine !== null) restLineRef.current = hoverLine;
  }, [focusLine, hoverLine]);

  const lineAtPointer = useCallback(
    (clientY: number) => {
      const rect = railRectRef.current;
      if (!rect || pitch <= 0) return null;
      const line = Math.floor((clientY - rect.top) / pitch);
      if (line < 0 || line >= lineCount) return null;
      return line;
    },
    [lineCount, pitch],
  );

  const ticks = useMemo(
    () =>
      Array.from({ length: lineCount }, (_, line) => (
        <button
          key={line}
          type="button"
          aria-label="Jump to message"
          onClick={() => scrollTo(userMessages[indexForLine(line)]!.uuid)}
          onFocus={(e) => {
            if (e.currentTarget.matches(":focus-visible")) setHoverLine(line);
          }}
          style={{ height: pitch, "--i": line } as React.CSSProperties}
          className="msg-rail-tick flex w-7 items-center justify-end"
        >
          <span className="h-px w-4 origin-right rounded-full bg-current" />
        </button>
      )),
    // Deliberately independent of hover and of the active line, so a scrub
    // never re-renders the ticks — CSS reads both off `--h` instead.
    [lineCount, pitch, scrollTo, userMessages],
  );

  if (count === 0 || availH === 0) return null;

  const hovered =
    hoverLine === null ? null : userMessages[indexForLine(hoverLine)];
  const cardLine = hoverLine ?? restLineRef.current;

  // The reply is looked up only for the card that is actually open, so a
  // streaming transcript never pays to build previews nobody is reading.
  let reply = "";
  if (hovered) {
    const at = messages.findIndex((m) => m.uuid === hovered.uuid);
    for (let i = at + 1; i >= 0 && i < messages.length; i++) {
      const m = messages[i]!;
      if (isRealUserTurn(m)) break;
      if (m.role !== "assistant") continue;
      const text = plainText(m, REPLY_LIMIT);
      if (text) {
        reply = text;
        break;
      }
    }
  }

  const railH = lineCount * pitch;
  const cardTop = Math.min(
    Math.max(0, cardLine * pitch + pitch / 2 - CARD_HEIGHT_PX / 2),
    Math.max(0, railH - CARD_HEIGHT_PX),
  );

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-3 z-20 flex items-center"
      style={{ paddingTop: RAIL_INSET_PX, paddingBottom: RAIL_INSET_PX }}
    >
      <div className="relative" style={{ height: railH }}>
        <div
          className="pointer-events-none absolute top-0 right-8 w-64"
          style={{ height: railH }}
        >
          <div
            data-open={hovered !== null}
            style={{
              height: CARD_HEIGHT_PX,
              transform: `translateY(${cardTop}px)`,
            }}
            className="msg-rail-card absolute inset-x-0 top-0 overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] p-3 shadow-xl"
          >
            <p className="line-clamp-1 text-[12px] leading-4 text-[var(--text)]">
              {hovered?.text || "Message"}
            </p>
            {reply && (
              <p className="mt-1 line-clamp-2 text-[12px] leading-4 text-[var(--text-secondary)]">
                {reply}
              </p>
            )}
          </div>
        </div>

        <div
          ref={railRef}
          aria-label="Message navigation"
          className="msg-rail pointer-events-auto relative flex w-7 flex-col text-[var(--text-tertiary)]"
          style={{ height: railH }}
          onPointerEnter={() => {
            railRectRef.current =
              railRef.current?.getBoundingClientRect() ?? null;
          }}
          onPointerMove={(e) => {
            const line = lineAtPointer(e.clientY);
            setHoverLine((prev) => (prev === line ? prev : line));
          }}
          onPointerLeave={() => setHoverLine(null)}
          // The rail sits over the transcript but outside it, so a wheel here
          // would otherwise land on nothing. Forward it to the pane.
          onWheel={(e) => scrollRef.current?.scrollBy({ top: e.deltaY })}
        >
          {ticks}
          <span
            aria-hidden
            style={{
              transform: `translateY(${activeLine * pitch + pitch / 2 - 0.5}px)`,
            }}
            className="msg-rail-active pointer-events-none absolute top-0 right-0 h-px w-4 rounded-full bg-[var(--accent)]"
          />
        </div>
      </div>
    </div>
  );
}
