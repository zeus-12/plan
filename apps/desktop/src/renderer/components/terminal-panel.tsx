import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTheme } from "@plan/shared/components/theme-provider";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  /** Paste text into the pty as terminal input (honours bracketed-paste mode). */
  paste: (text: string) => void;
  focus: () => void;
}

interface Props {
  /** Terminal id — the pty key in main (e.g. "proj:<enc>" or "chat:<enc>:<sid>"). */
  id: string;
  /** Project encoded dir — main resolves the pty cwd from it. */
  encoded: string;
  /** Sub-repo path within the project — main joins it onto the resolved cwd. */
  subPath?: string;
  /** Header label (e.g. "Claude", "Terminal 2"). */
  label?: string;
  /** Hide the title/close header row (e.g. embedded in the sidebar). */
  showHeader?: boolean;
  /** Run once when the pty is first created (e.g. `claude --resume <id>`). */
  initialCommand?: string;
  /** Whether the panel is currently shown (drives refit + focus). */
  visible: boolean;
  onClose?: () => void;
  /** ⌘W while this terminal is focused asks to close it (scratch shells). */
  onRequestClose?: () => void;
  /** The attach result from main: `error` when no pty is running and none could
   *  be started, so the owner can drop the pane instead of showing a dead one. */
  onOpened?: (result: { error?: string }) => void;
  /** Changing this value forces a refit (e.g. the dock height during a drag). */
  fitSignal?: number;
}

/**
 * Map mac-style editing keys to the control sequences a shell / TUI expects.
 * Returns null for keys we don't override (xterm handles them normally).
 *
 *   ⌘←  → start of line (Ctrl-A)      ⌘→  → end of line (Ctrl-E)
 *   ⌥←  → word left (Esc-b)           ⌥→  → word right (Esc-f)
 *   ⌘⌫  → delete to start of line (Ctrl-U)
 *   ⇧↵  → insert newline without submitting (LF, which Claude's TUI and most
 *         line editors treat as a literal newline vs CR = submit)
 */
function controlSequenceFor(e: KeyboardEvent): string | null {
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") return "\x1bb";
    if (e.key === "ArrowRight") return "\x1bf";
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === "ArrowLeft") return "\x01";
    if (e.key === "ArrowRight") return "\x05";
    if (e.key === "Backspace") return "\x15";
  }
  if (
    e.shiftKey &&
    e.key === "Enter" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    return "\n";
  }
  return null;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

// The 16 ANSI slots xterm accepts, keyed as in its `ITheme` (camelCase). Their
// values live per-theme in shared/themes/*.json under `terminal` and reach us as
// `--term-*` CSS variables (bright-black → brightBlack).
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

let warnedMissingPalette = false;

// The ANSI palette for the active theme, read straight from its `--term-*` CSS
// variables — the theme JSON is the single source of truth. A missing colour is
// simply omitted, so xterm keeps its own built-in default for that slot; if a
// theme defines no palette at all we warn once (rather than duplicate a copy of
// the colours here) and let xterm's defaults stand.
function ansiPalette(): Partial<ITheme> {
  const out: Record<string, string> = {};
  for (const name of ANSI_KEYS) {
    const value = cssVar(`--term-${kebab(name)}`, "");
    if (value) out[name] = value;
  }
  if (Object.keys(out).length === 0 && !warnedMissingPalette) {
    warnedMissingPalette = true;
    console.warn(
      "[terminal] active theme has no `terminal` palette (--term-* vars missing); using xterm's default ANSI colors.",
    );
  }
  return out as Partial<ITheme>;
}

// The full xterm theme: base colours + ANSI palette, all read from the live CSS
// vars of the active theme. Reused by the initial construction and the live
// theme-swap effect so there's a single source of truth.
function buildTerminalTheme(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  return {
    background: cssVar("--bg", isDark ? "#09090b" : "#ffffff"),
    foreground: cssVar("--text", isDark ? "#e4e4e7" : "#18181b"),
    cursor: cssVar("--text", isDark ? "#e4e4e7" : "#18181b"),
    selectionBackground: cssVar("--selection-bg", "rgba(120,120,160,0.4)"),
    ...ansiPalette(),
  };
}

// How many lines of output stay scrollable (and so selectable/copyable) before
// the oldest are dropped. xterm allocates a row lazily, as `3 * cols` uint32s —
// ~1.4 KB per 120-column line — so an idle terminal costs nothing and the cap
// only bites on output actually produced: a run that really emits 100k lines
// holds ~140 MB. Rendering is unaffected either way (only the viewport paints).
const SCROLLBACK_LINES = 100_000;

/**
 * An embedded terminal bound to the project's pty (cwd = project dir). The pty
 * lives in the main process and persists across ⌘J toggles and project
 * switches; this view just attaches to it.
 */
export const TerminalPanel = forwardRef<TerminalHandle, Props>(
  function TerminalPanel(
    {
      id,
      encoded,
      subPath,
      label,
      showHeader = true,
      initialCommand,
      visible,
      onClose,
      onRequestClose,
      onOpened,
      fitSignal,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const { theme } = useTheme();

    // Held in refs so changing a callback doesn't tear down the pty.
    const onRequestCloseRef = useRef(onRequestClose);
    onRequestCloseRef.current = onRequestClose;
    const onOpenedRef = useRef(onOpened);
    onOpenedRef.current = onOpened;

    // While hidden, output is buffered (capped) instead of parsed/rendered —
    // a hidden xterm processing a streaming TUI burns the main thread for
    // nothing. The tail is flushed when the panel becomes visible.
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const hiddenBufRef = useRef("");

    useImperativeHandle(
      ref,
      () => ({
        paste: (text: string) => {
          const term = termRef.current;
          if (!term) return;
          term.paste(text);
          term.focus();
        },
        focus: () => termRef.current?.focus(),
      }),
      [],
    );
    // Last dimensions we told the pty about — used to suppress no-op resizes
    // (the ResizeObserver → fit → resize loop is what makes xterm "blink").
    const lastDims = useRef<{ cols: number; rows: number }>({
      cols: 0,
      rows: 0,
    });
    const rafRef = useRef<number | null>(null);
    // The single fit implementation, published by the setup effect so the
    // visibility / height-drag effects reuse it instead of each rolling their own.
    const runFitRef = useRef<(() => void) | null>(null);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
        fontSize: 12,
        cursorBlink: true,
        scrollback: SCROLLBACK_LINES,
        theme: buildTerminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;

      // Local key handling: ⌘K clears; ⌘/⌥+arrows and ⇧Enter are translated to
      // the readline / TUI control sequences so the terminal feels like a normal
      // mac text field. Returning false stops xterm from also forwarding the key.
      term.attachCustomKeyEventHandler((e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          if (e.type === "keydown") term.clear();
          return false;
        }
        // ⌘↑ / ⌘↓ jump the viewport to the very top / bottom of the scrollback
        // (like a text field's document ends), rather than reaching the shell.
        if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "ArrowUp") {
          if (e.type === "keydown") term.scrollToTop();
          return false;
        }
        if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "ArrowDown") {
          if (e.type === "keydown") term.scrollToBottom();
          return false;
        }
        // ⌘C copies the selection, but xterm pads every row to the full
        // terminal width and the prompt leaves blank rows below it — so the
        // raw selection carries a block of spaces and empty lines after the
        // real text. Strip only that trailing run (\s+$ = spaces + newlines at
        // the very end); interior blank lines are left untouched. Ctrl-C is
        // deliberately excluded so it stays SIGINT.
        if (
          e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          e.key.toLowerCase() === "c" &&
          term.hasSelection()
        ) {
          if (e.type === "keydown") {
            const text = term.getSelection().replace(/\s+$/, "");
            if (text) void navigator.clipboard.writeText(text);
          }
          return false;
        }
        // ⌘W closes this terminal when it's the focused one (scratch shells only;
        // the agent terminal passes no onRequestClose). Swallow it so it neither
        // reaches the shell nor triggers a window close. stopPropagation is
        // essential: the content pane has a window-level ⌘W listener that closes
        // the active middle-pane tab — without it, one keypress would close both
        // the terminal and the tab.
        if (
          (e.metaKey || e.ctrlKey) &&
          e.key.toLowerCase() === "w" &&
          onRequestCloseRef.current
        ) {
          if (e.type === "keydown") {
            e.preventDefault();
            e.stopPropagation();
            onRequestCloseRef.current();
          }
          return false;
        }
        const seq = controlSequenceFor(e);
        if (seq != null) {
          if (e.type === "keydown") window.electronAPI.terminalInput(id, seq);
          return false;
        }
        return true;
      });

      // Idempotent fit: recompute cols/rows from the container and push a resize
      // only when they actually change — both to break the ResizeObserver
      // feedback loop and to keep the pty (and Claude's TUI) off the hot path
      // during pixel-level drags. On a real change we repaint the viewport and
      // re-pin to the bottom: reflowing to a new WIDTH can leave wrapped rows
      // half-painted under the DOM renderer, which is what makes the text look
      // garbled at different widths. The repaint runs only on an actual
      // dimension change, so it stays cheap.
      const runFit = () => {
        // Never resize the pty while the panel is hidden. When the sidebar
        // collapses its width animates to 0, so its intermediate sliver widths
        // must not reach the pty — otherwise Claude's TUI reflows down to a
        // couple of columns and (once the panel is off-screen) never gets a
        // correcting fit, leaving it "2 characters wide" on reopen.
        if (!visibleRef.current) return;
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        const { cols, rows } = term;
        if (cols === lastDims.current.cols && rows === lastDims.current.rows) {
          return;
        }
        lastDims.current = { cols, rows };
        window.electronAPI.terminalResize(id, cols, rows);
        term.refresh(0, Math.max(0, rows - 1));
        term.scrollToBottom();
      };
      runFitRef.current = runFit;
      const scheduleFit = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          runFit();
        });
      };

      scheduleFit();
      // Attaches to the pty, creating it only if nothing has yet — a chat pane
      // finds one its engine already started. The result is reported back: a
      // failed attach leaves NO pty, so an owner that waits for `exit` to tell
      // it the pane is dead would wait forever.
      let attached = true;
      void window.electronAPI
        .terminalOpen(
          id,
          encoded,
          term.cols,
          term.rows,
          initialCommand,
          subPath,
        )
        .then((r) => {
          if (attached) onOpenedRef.current?.({ error: r.error });
        });

      const offData = window.electronAPI.onTerminalData((chunk) => {
        if (chunk.id !== id) return;
        if (visibleRef.current) {
          term.write(chunk.data);
        } else {
          hiddenBufRef.current += chunk.data;
          // Keep only the tail — enough to reconstruct the current TUI frame.
          if (hiddenBufRef.current.length > 500_000) {
            hiddenBufRef.current = hiddenBufRef.current.slice(-400_000);
          }
        }
      });
      const inputSub = term.onData((d) =>
        window.electronAPI.terminalInput(id, d),
      );

      // A pty is a text stream, so xterm only pastes text. Intercept image
      // pastes: write the bitmap to a temp file and type its path, which Claude
      // Code reads as an attached image.
      const onPaste = (e: ClipboardEvent) => {
        const item = Array.from(e.clipboardData?.items ?? []).find((it) =>
          it.type.startsWith("image/"),
        );
        if (!item) return; // text paste — let xterm handle it
        e.preventDefault();
        e.stopImmediatePropagation();
        const file = item.getAsFile();
        if (!file) return;
        const ext = item.type.split("/")[1] || "png";
        void file.arrayBuffer().then(async (buf) => {
          const path = await window.electronAPI.saveTempImage(
            new Uint8Array(buf),
            ext,
          );
          if (path) window.electronAPI.terminalInput(id, `${path} `);
        });
      };
      host.addEventListener("paste", onPaste, true);

      const ro = new ResizeObserver(scheduleFit);
      ro.observe(host);

      return () => {
        attached = false;
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        offData();
        inputSub.dispose();
        host.removeEventListener("paste", onPaste, true);
        ro.disconnect();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
        runFitRef.current = null;
        // Intentionally NOT killing the pty — it persists in main.
      };
    }, [id]);

    // Re-read the CSS vars on theme change so a mounted terminal re-colors live
    // (the classList swap happens before this effect runs, so the vars are new).
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = buildTerminalTheme();
      // Swapping the theme updates the palette but the DOM renderer doesn't
      // repaint cells already on screen (the prompt, prior output), so a switch
      // leaves the terminal half-recolored until the next keystroke/scroll. Force
      // a full repaint of the viewport — same refresh the resize path uses.
      term.refresh(0, Math.max(0, term.rows - 1));
    }, [theme]);

    // The mono font is a webfont (loaded with `display: swap`), so xterm first
    // measures the character cell against the fallback font — which is wider —
    // and locks in too few columns: text under-fills the pane and never reflows
    // to the real glyph width, even on resize (fit() reuses the stale cell). Once
    // the font is ready, force xterm to re-measure (toggling fontFamily retriggers
    // its CharSizeService) and refit so cols match the actual width.
    useEffect(() => {
      let cancelled = false;
      void document.fonts.ready.then(() => {
        const term = termRef.current;
        if (cancelled || !term) return;
        const ff = term.options.fontFamily;
        term.options.fontFamily = "monospace";
        term.options.fontFamily = ff;
        runFitRef.current?.();
      });
      return () => {
        cancelled = true;
      };
    }, [id]);

    // Refit + focus when shown (it may have been display:none with 0 size, or
    // the container may have changed width while hidden).
    useEffect(() => {
      if (!visible) return;
      // Flush output that arrived while hidden so the current frame shows.
      if (hiddenBufRef.current && termRef.current) {
        termRef.current.write(hiddenBufRef.current);
        hiddenBufRef.current = "";
      }
      const raf = requestAnimationFrame(() => {
        runFitRef.current?.();
        // runFit only scrolls on a dimension change; on a plain re-show the dims
        // are unchanged, so pin to the bottom explicitly after the buffer flush.
        termRef.current?.scrollToBottom();
        termRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }, [visible, id]);

    // Refit when the dock is resized (height changes). Tied directly to the drag
    // so the terminal reflows instead of cropping, independent of the observer.
    useEffect(() => {
      if (!visible) return;
      const raf = requestAnimationFrame(() => runFitRef.current?.());
      return () => cancelAnimationFrame(raf);
    }, [fitSignal, visible, id]);

    return (
      <div className="flex h-full w-full flex-col bg-[var(--bg)]">
        {showHeader && (
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            <span>{label ?? "Terminal"}</span>
            <button
              onClick={onClose}
              title="Close (⌘J)"
              className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
            >
              ×
            </button>
          </div>
        )}
        <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden pl-2" />
      </div>
    );
  },
);
