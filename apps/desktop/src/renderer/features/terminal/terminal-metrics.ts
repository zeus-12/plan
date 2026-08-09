/**
 * What a mounted terminal pane measures about itself, readable by id from
 * outside React.
 *
 * Main knows the pty's size; only the pane knows the pixels it was actually
 * given and how tall xterm rendered itself into them. When those disagree the
 * bottom rows are clipped — present in the buffer, invisible on screen, and
 * unreachable because a TUI on the alternate screen has no scrollback. Nothing
 * on the page can show that, so the debug menu reads it from here.
 */
export interface TerminalPaneMetrics {
  /** The grid this pane's xterm believes it has. */
  cols: number;
  rows: number;
  /** The element that clips the terminal (`overflow-hidden`). */
  hostWidth: number;
  hostHeight: number;
  /** xterm's own rendered size. Taller than the host = clipped bottom. */
  renderedWidth: number;
  renderedHeight: number;
  /** Rows the host has room for at the current rendered row height. */
  visibleRows: number;
  /** The pane is mounted and being fed output (a hidden pane buffers instead). */
  visible: boolean;
}

const readers = new Map<string, () => TerminalPaneMetrics | null>();

/** Called by a mounted pane; the returned function deregisters it. */
export function registerTerminalMetrics(
  id: string,
  read: () => TerminalPaneMetrics | null,
): () => void {
  readers.set(id, read);
  return () => {
    if (readers.get(id) === read) readers.delete(id);
  };
}

/** Live measurements for `id`, or null when no pane is mounted for it. */
export function readTerminalMetrics(id: string): TerminalPaneMetrics | null {
  return readers.get(id)?.() ?? null;
}
