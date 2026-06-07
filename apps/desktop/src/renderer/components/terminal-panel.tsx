import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  /** Run once when the pty is first created (e.g. `claude --resume <id>`). */
  initialCommand?: string;
  /** Whether the panel is currently shown (drives refit + focus). */
  visible: boolean;
  onClose: () => void;
  /** Fired once the pty is open and ready to receive input. */
  onReady?: () => void;
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
  if (e.shiftKey && e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
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

/**
 * An embedded terminal bound to the project's pty (cwd = project dir). The pty
 * lives in the main process and persists across ⌘J toggles and project
 * switches; this view just attaches to it.
 */
export const TerminalPanel = forwardRef<TerminalHandle, Props>(
  function TerminalPanel(
    { id, encoded, initialCommand, visible, onClose, onReady, fitSignal },
    ref
  ) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Held in a ref so changing the callback's identity doesn't tear down the pty.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // While hidden, output is buffered (capped) instead of parsed/rendered —
  // a hidden xterm processing a streaming TUI burns the main thread for
  // nothing. The tail is flushed when the panel becomes visible.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const hiddenBufRef = useRef("");

  useImperativeHandle(ref, () => ({
    paste: (text: string) => {
      const term = termRef.current;
      if (!term) return;
      term.paste(text);
      term.focus();
    },
    focus: () => termRef.current?.focus(),
  }), []);
  // Last dimensions we told the pty about — used to suppress no-op resizes
  // (the ResizeObserver → fit → resize loop is what makes xterm "blink").
  const lastDims = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const isDark = document.documentElement.classList.contains("dark");
    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12,
      cursorBlink: true,
      // The DOM renderer repaints aggressively; scrollback is cheap.
      scrollback: 5000,
      theme: {
        background: cssVar("--bg", isDark ? "#09090b" : "#ffffff"),
        foreground: cssVar("--text", isDark ? "#e4e4e7" : "#18181b"),
        cursor: cssVar("--text", isDark ? "#e4e4e7" : "#18181b"),
        selectionBackground: cssVar("--selection-bg", "rgba(120,120,160,0.4)"),
      },
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
      const seq = controlSequenceFor(e);
      if (seq != null) {
        if (e.type === "keydown") window.electronAPI.terminalInput(id, seq);
        return false;
      }
      return true;
    });

    // Coalesced, idempotent fit: only push a resize to the pty when the
    // computed cols/rows actually change. Prevents the observer feedback loop.
    const doFit = () => {
      rafRef.current = null;
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
    };
    const scheduleFit = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(doFit);
    };

    scheduleFit();
    window.electronAPI
      .terminalOpen(id, encoded, term.cols, term.rows, initialCommand)
      .then(() => onReadyRef.current?.());

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
      window.electronAPI.terminalInput(id, d)
    );

    // A pty is a text stream, so xterm only pastes text. Intercept image
    // pastes: write the bitmap to a temp file and type its path, which Claude
    // Code reads as an attached image.
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((it) =>
        it.type.startsWith("image/")
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
          ext
        );
        if (path) window.electronAPI.terminalInput(id, `${path} `);
      });
    };
    host.addEventListener("paste", onPaste, true);

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      offData();
      inputSub.dispose();
      host.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Intentionally NOT killing the pty — it persists in main.
    };
  }, [id]);

  // Refit + focus when shown (it may have been display:none with 0 size).
  useEffect(() => {
    if (!visible) return;
    // Flush output that arrived while hidden so the current frame shows.
    if (hiddenBufRef.current && termRef.current) {
      termRef.current.write(hiddenBufRef.current);
      hiddenBufRef.current = "";
    }
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      const host = hostRef.current;
      if (!term || !fit || !host || host.clientHeight === 0) return;
      try {
        fit.fit();
        if (
          term.cols !== lastDims.current.cols ||
          term.rows !== lastDims.current.rows
        ) {
          lastDims.current = { cols: term.cols, rows: term.rows };
          window.electronAPI.terminalResize(id, term.cols, term.rows);
        }
        term.scrollToBottom();
      } catch {
        /* ignore */
      }
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, id]);

  // Refit when the dock is resized (height changes). Tied directly to the drag
  // so the terminal reflows instead of cropping, independent of the observer.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      const host = hostRef.current;
      if (!term || !fit || !host || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (
        term.cols !== lastDims.current.cols ||
        term.rows !== lastDims.current.rows
      ) {
        lastDims.current = { cols: term.cols, rows: term.rows };
        window.electronAPI.terminalResize(id, term.cols, term.rows);
      }
      term.refresh(0, term.rows - 1);
      term.scrollToBottom();
    });
    return () => cancelAnimationFrame(raf);
  }, [fitSignal, visible, id]);

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        <span>Terminal</span>
        <button
          onClick={onClose}
          title="Close (⌘J)"
          className="flex h-5 w-5 items-center justify-center rounded text-[14px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
        >
          ×
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden pl-2" />
    </div>
  );
});
