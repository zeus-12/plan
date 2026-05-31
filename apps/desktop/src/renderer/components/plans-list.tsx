import { cn } from "@plan/shared/lib/utils";
import type { Plan } from "../../shared-types";
import { relativeTime } from "../lib/time";

interface Props {
  plans: Plan[];
  selected: string | null;
  onSelect: (filePath: string) => void;
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function PlansList({ plans, selected, onSelect }: Props) {
  if (plans.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No plans yet
      </div>
    );
  }

  // Most-recent first
  const ordered = [...plans].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        Active plans
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {ordered.map((p) => {
          const isSelected = p.filePath === selected;
          const name = basename(p.filePath);
          return (
            <button
              key={p.filePath}
              onClick={() => onSelect(p.filePath)}
              title={p.filePath}
              className={cn(
                "flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition-colors",
                isSelected
                  ? "border-l-[var(--accent)] bg-[var(--bg-surface-hover)]"
                  : "border-l-transparent hover:bg-[var(--bg-surface-hover)]"
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[12px]",
                    isSelected
                      ? "text-[var(--text)]"
                      : "text-[var(--text-secondary)]"
                  )}
                >
                  {name}
                </span>
                {p.unread > 0 && (
                  <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-semibold text-[var(--bg)]">
                    {p.unread}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
                <span>{relativeTime(p.updatedAt)}</span>
                <span>·</span>
                <span>
                  {p.versions.length} version
                  {p.versions.length !== 1 ? "s" : ""}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
