import {
  isTerminalRunning,
  terminalDims,
  terminalScreen,
} from "@/main/terminal/terminal";
import {
  classifyInputState,
  screenIsBusy,
} from "@/main/providers/claude-code/tui-screen";
import { agentLiveIn } from "@/main/providers/claude-code/tui-activity";
import type { TerminalDebugFrame } from "@/common/shared-types";

/**
 * A snapshot of everything main knows about one terminal's screen, for the
 * debug menu to copy out. Deliberately spans layers the rest of main keeps
 * apart (raw pty + the Claude TUI heuristics that read it), because the whole
 * point is to compare them: the composer is gated on what the heuristics see
 * here, and when that disagrees with the pane on screen, this is the only way
 * to find out which side is wrong.
 *
 * Reports what it observed and nothing more — an id with no pty comes back
 * `running: false` with an empty screen rather than a plausible-looking blank.
 */
export async function terminalDebugFrame(
  id: string,
): Promise<TerminalDebugFrame> {
  if (!isTerminalRunning(id)) {
    return {
      id,
      running: false,
      cols: 0,
      rows: 0,
      screen: [],
      inputState: "unknown",
      matchedLines: [],
      agentLive: false,
      busy: false,
    };
  }
  const screen = terminalScreen(id);
  const dims = terminalDims(id);
  const { state, lines } = classifyInputState(screen);
  return {
    id,
    running: true,
    cols: dims?.cols ?? 0,
    rows: dims?.rows ?? 0,
    screen,
    inputState: state,
    matchedLines: lines,
    agentLive: await agentLiveIn(id),
    busy: screenIsBusy(screen),
  };
}
