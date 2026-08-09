import { useCallback, useEffect, useRef, useState } from "react";
import { readTerminalMetrics } from "@/renderer/features/terminal/terminal-metrics";
import { formatTerminalFrame } from "./terminal-frame-report";

/**
 * The debug menu — shown in the workspace header only while Debug mode is on
 * (Settings → Debug, off again on every launch).
 *
 * One place to hang "copy the state you'd otherwise have to guess at" actions.
 * Each item copies a plain-text report to the clipboard, meant to be pasted
 * straight into a chat or an issue.
 */

interface Props {
  /** The chat terminal the actions target; null when no chat is selected. */
  terminalId: string | null;
}

function BugIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v3M16 2v3M5 9a7 7 0 0 1 14 0v4a7 7 0 0 1-14 0z" />
      <path d="M2 12h3M19 12h3M3 6l2 2M21 6l-2 2M3 18l2-2M21 18l-2-2" />
    </svg>
  );
}

export function DebugMenu({ terminalId }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const copyTerminalFrame = useCallback(async () => {
    setOpen(false);
    if (!terminalId) {
      setStatus("No chat terminal selected");
      return;
    }
    const frame = await window.electronAPI.terminalDebugFrame(terminalId);
    const report = formatTerminalFrame(frame, readTerminalMetrics(terminalId));
    await navigator.clipboard.writeText(report);
    setStatus(frame.running ? "Frame copied" : "No pty running — copied");
  }, [terminalId]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex items-center">
      {status && (
        <span
          role="status"
          className="mr-2 text-[11px] text-[var(--text-tertiary)]"
        >
          {status}
        </span>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Debug"
        aria-expanded={open}
        title="Debug"
        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
      >
        <BugIcon />
        <span>Debug</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-max min-w-[210px] rounded-md border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 shadow-lg">
          <button
            onClick={() => void copyTerminalFrame()}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
          >
            <span className="flex-1">Copy terminal frame</span>
          </button>
        </div>
      )}
    </div>
  );
}
