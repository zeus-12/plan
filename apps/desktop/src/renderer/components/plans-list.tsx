import { useEffect, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@plan/shared/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@plan/shared/components/ui/tooltip";
import { Button } from "@plan/shared/components/ui/button";
import { cn } from "@plan/shared/lib/utils";
import type { Plan } from "../../shared-types";
import { relativeTime } from "../lib/time";

interface Props {
  plans: Plan[];
  selected: string | null;
  onSelect: (filePath: string) => void;
  onSetArchived: (filePath: string, archived: boolean) => void;
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function PlansList({ plans, selected, onSelect, onSetArchived }: Props) {
  // When true the list transforms into an archived-only view.
  const [archivedView, setArchivedView] = useState(false);

  const { active, archived } = useMemo(() => {
    const a: Plan[] = [];
    const ar: Plan[] = [];
    for (const p of plans) (p.archived ? ar : a).push(p);
    // Most-recent first.
    const byRecent = (x: Plan, y: Plan) => y.updatedAt - x.updatedAt;
    a.sort(byRecent);
    ar.sort(byRecent);
    return { active: a, archived: ar };
  }, [plans]);

  // Leave the archived view automatically once it's empty.
  useEffect(() => {
    if (archivedView && archived.length === 0) setArchivedView(false);
  }, [archivedView, archived.length]);

  const shown = archivedView ? archived : active;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {archivedView ? (
        <button
          onClick={() => setArchivedView(false)}
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
          title="Back to plans"
        >
          <ChevronLeftIcon />
          <span className="flex-1">Archived plans</span>
          <span>{archived.length}</span>
        </button>
      ) : (
        <div className="shrink-0 border-b border-[var(--border)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
          Active plans
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
            {archivedView ? "No archived plans" : "No plans yet"}
          </div>
        ) : (
          shown.map((p) => {
            const isSelected = p.filePath === selected;
            const name = basename(p.filePath);
            return (
              <ContextMenu key={p.filePath}>
                <ContextMenuTrigger asChild>
                  <button
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
                      {!p.archived && p.unread > 0 && (
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
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {p.archived ? (
                    <ContextMenuItem
                      onSelect={() => onSetArchived(p.filePath, false)}
                    >
                      Unarchive
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem
                      onSelect={() => onSetArchived(p.filePath, true)}
                    >
                      Archive
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>
      {archived.length > 0 && (
        <div className="flex shrink-0 items-center justify-end border-t border-[var(--border)] px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Archived plans"
                onClick={() => setArchivedView((v) => !v)}
                className={cn(
                  archivedView && "border-[var(--accent)] text-[var(--accent)]"
                )}
              >
                <TrashIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {archivedView ? "Back to plans" : "Archived plans"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function ChevronLeftIcon() {
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
