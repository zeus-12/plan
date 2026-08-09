import type { TerminalDebugFrame } from "@/common/shared-types";
import type { TerminalPaneMetrics } from "@/renderer/features/terminal/terminal-metrics";

/**
 * Render a captured frame as plain text meant to be pasted into a chat.
 *
 * The two sizes are the point of the whole report. Main's emulator is what the
 * composer's gating reads; the pane is what you can see. A frame where those
 * agree but the send button still looks wrong is a heuristics bug; a frame where
 * they disagree is a sizing bug — and until now there was no way to tell which
 * one you were looking at.
 */
export function formatTerminalFrame(
  frame: TerminalDebugFrame,
  pane: TerminalPaneMetrics | null,
): string {
  const out: string[] = [];
  const field = (label: string, value: string) =>
    out.push(`${label.padEnd(13)}${value}`);

  out.push("=== plan terminal frame ===");
  field("terminal", frame.id);
  field("pty", frame.running ? "running" : "not running");

  if (!frame.running) {
    return `${out.join("\n")}\n\n(no pty under this id — nothing to read)\n`;
  }

  field("main screen", `${frame.cols}x${frame.rows} cols x rows`);
  if (pane) {
    field("pane grid", `${pane.cols}x${pane.rows} cols x rows`);
    field(
      "pane box",
      `${Math.round(pane.hostWidth)}x${Math.round(pane.hostHeight)}px`,
    );
    field(
      "pane drawn",
      `${Math.round(pane.renderedWidth)}x${Math.round(pane.renderedHeight)}px` +
        ` (fits ${pane.visibleRows} rows)`,
    );
    field("pane state", pane.visible ? "visible" : "hidden (buffering)");
  } else {
    field("pane", "not mounted — no on-screen pane for this id");
  }
  field("classified", frame.inputState);
  field("agent live", frame.agentLive ? "yes" : "no");
  field("busy", frame.busy ? "yes" : "no");

  for (const line of mismatches(frame, pane)) out.push(`  ! ${line}`);

  out.push(
    "",
    `--- classifier read these ${frame.matchedLines.length} lines ---`,
  );
  out.push(...frame.matchedLines);

  out.push("", `--- full screen (${frame.screen.length} rows) ---`);
  const width = String(frame.screen.length).length;
  frame.screen.forEach((line, i) =>
    out.push(`${String(i + 1).padStart(width)}| ${line}`),
  );

  return `${out.join("\n")}\n`;
}

/** Discrepancies worth calling out at the top, each stated as an observation. */
function mismatches(
  frame: TerminalDebugFrame,
  pane: TerminalPaneMetrics | null,
): string[] {
  if (!pane) return [];
  const notes: string[] = [];
  if (pane.rows !== frame.rows || pane.cols !== frame.cols) {
    notes.push(
      `pane grid and main's emulator disagree: pane ${pane.cols}x${pane.rows}, main ${frame.cols}x${frame.rows}`,
    );
  }
  if (pane.visibleRows > 0 && pane.rows > pane.visibleRows) {
    notes.push(
      `terminal draws ${pane.rows} rows into a box with room for ${pane.visibleRows} — bottom ${pane.rows - pane.visibleRows} row(s) clipped`,
    );
  }
  return notes;
}
