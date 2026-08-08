/**
 * Native Claude Code slash commands surfaced in the composer's `/` menu next to
 * on-disk skills. Selecting one inserts a `/name` chip that pastes as the literal
 * command into the TUI (same reference-node path as a skill).
 *
 * Curated by hand on purpose: the CLI ships no machine-readable list of its
 * built-in commands (see the "built-in skills have no source" note), so we only
 * list ones we've verified and actively support. Keep it small; add entries as
 * their in-app behavior is handled (e.g. `/branch` is followed by the pty-rekey
 * logic — don't add `/clear` or `/resume` until their session switch is too).
 */
export interface BuiltinCommand {
  /** Command word without the leading slash — serializes to `/name`. */
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    name: "branch",
    description: "Fork this conversation into a new session from here",
  },
];

/** Built-in commands matching `query` (substring on name/description), name-first. */
export function searchBuiltinCommands(
  query: string,
  limit = 10,
): BuiltinCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return BUILTIN_COMMANDS.slice(0, limit);
  return BUILTIN_COMMANDS.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  ).slice(0, limit);
}
