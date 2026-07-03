import type {
  CommandEntry,
  DiscoveredRepo,
  ProjectDefaults,
} from "../../shared-types";

// Monotonic within a session; combined with a base36 timestamp so ids added in
// one sitting don't collide. Persisted once saved, so ptys keyed by them survive
// reloads (the id is the stable part of the pty name `run:<enc>:<id>`).
let seq = 0;
export function newEntryId(): string {
  seq += 1;
  return `e${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * The project's Run command list, migrating the legacy single `runCommand` into
 * a one-entry list when the newer `runCommands` isn't set yet.
 */
export function runEntriesOf(defaults: ProjectDefaults): CommandEntry[] {
  if (defaults.runCommands) return defaults.runCommands;
  const legacy = defaults.runCommand?.trim();
  return legacy ? [{ id: "run", command: legacy }] : [];
}

/** Same as {@link runEntriesOf} for the Build list. */
export function buildEntriesOf(defaults: ProjectDefaults): CommandEntry[] {
  if (defaults.buildCommands) return defaults.buildCommands;
  const legacy = defaults.buildCommand?.trim();
  return legacy ? [{ id: "build", command: legacy }] : [];
}

/**
 * Label for an entry's sub-tab: the target repo's folder name when the entry is
 * bound to a sub-repo, otherwise the command itself (so several commands in a
 * single repo stay distinguishable — `npm run dev` vs `npm run test`, not two
 * "npm"s). The sub-tab truncates it visually and shows the full command on hover.
 * Falls back to a positional name like "Run 2" for an empty command.
 */
export function entryLabel(
  entry: CommandEntry,
  repos: DiscoveredRepo[],
  fallback: string,
): string {
  if (entry.subPath) {
    const name =
      repos.find((r) => r.subPath === entry.subPath)?.subPath || entry.subPath;
    return name.split("/").pop() || name;
  }
  return entry.command.trim() || fallback;
}
