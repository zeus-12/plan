import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  encoded: string;
  /** Whether the panel is currently shown (drives refit + focus). */
  visible: boolean;
  onClose: () => void;
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
export function TerminalPanel({ encoded, visible, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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

    // ⌘K / Ctrl+K clears the terminal (kept out of the pty's input).
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (e.type === "keydown") term.clear();
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
      window.electronAPI.terminalResize(encoded, cols, rows);
    };
    const scheduleFit = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(doFit);
    };

    scheduleFit();
    window.electronAPI.terminalOpen(encoded, term.cols, term.rows);

    const offData = window.electronAPI.onTerminalData((chunk) => {
      if (chunk.encoded === encoded) term.write(chunk.data);
    });
    const inputSub = term.onData((d) =>
      window.electronAPI.terminalInput(encoded, d)
    );

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      offData();
      inputSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // Intentionally NOT killing the pty — it persists in main.
    };
  }, [encoded]);

  // Refit + focus when shown (it may have been display:none with 0 size).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
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
          window.electronAPI.terminalResize(encoded, term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }
      term.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, encoded]);

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
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
