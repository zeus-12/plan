import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { PLAN_DIR } from "./plan-config";

/**
 * Per-worktree scratchpad content, persisted under `~/.plan/scratch/<encoded>.json`.
 * Scoped by `encoded` (same key the tabs/terminals use) so each worktree keeps
 * its own buffer, and it survives a full app quit & relaunch — the scratchpad is
 * a durable notepad, not a transient tab. Stored on disk (not localStorage) so a
 * large paste never hits the ~5MB localStorage quota shared with the tab state.
 */

const SCRATCH_DIR = join(PLAN_DIR, "scratch");

export interface ScratchData {
  content: string;
  /** CodeMirror language id (e.g. "json", "javascript"), or "plaintext". */
  language: string;
}

function scratchPath(encoded: string): string {
  return join(SCRATCH_DIR, `${encoded}.json`);
}

/** Read a worktree's scratchpad, or null if it was never written. */
export async function readScratch(encoded: string): Promise<ScratchData | null> {
  try {
    const raw = await readFile(scratchPath(encoded), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ScratchData>;
    return {
      content: typeof parsed.content === "string" ? parsed.content : "",
      language:
        typeof parsed.language === "string" ? parsed.language : "plaintext",
    };
  } catch {
    // Missing file (never used) or unreadable/corrupt — start from a blank pad.
    return null;
  }
}

export async function writeScratch(
  encoded: string,
  data: ScratchData,
): Promise<void> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(scratchPath(encoded), JSON.stringify(data), "utf-8");
}
