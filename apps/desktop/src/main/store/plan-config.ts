import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

/**
 * Plan's own config/state lives here — separate from `~/.claude`, which is
 * owned by the Claude CLI (we only read/watch its `projects/`).
 */
export const PLAN_DIR = join(homedir(), ".plan");

export function planConfigPath(name: string): string {
  return join(PLAN_DIR, name);
}

/** Read a config file from `~/.plan`. Returns its contents, or null if absent. */
export async function readPlanConfig(name: string): Promise<string | null> {
  try {
    return await readFile(planConfigPath(name), "utf-8");
  } catch {
    return null;
  }
}

export async function writePlanConfig(
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(PLAN_DIR, { recursive: true });
  await writeFile(planConfigPath(name), contents, "utf-8");
}
