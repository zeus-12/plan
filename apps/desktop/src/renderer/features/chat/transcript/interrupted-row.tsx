import type { InterruptionKind } from "./message-kind";

/**
 * The marker Claude Code writes when you stop a reply, rendered like the other
 * machinery rows (see SystemMetaBlock): a muted verb plus what it applies to,
 * on the left edge of the reading column.
 */
export function InterruptedRow({ kind }: { kind: InterruptionKind }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px]">
      <span className="shrink-0 text-[var(--text-tertiary)]">Stopped</span>
      <span className="min-w-0 truncate text-[var(--text-secondary)]">
        {kind === "tool" ? "by you, during a tool call" : "by you"}
      </span>
    </div>
  );
}
