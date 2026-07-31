import { useEffect, useState } from "react";
import { cn, toggleInSet } from "@plan/shared/lib/utils";
import { TextShimmer } from "@plan/shared/components/ui/text-shimmer";
import type { DiscoveredRepo, PrSummary } from "../../shared-types";
import { usePrList } from "../lib/pr-store";
import { Chevron } from "./chevron";

interface Props {
  encoded: string;
  repos: DiscoveredRepo[];
  /** Display name per repo subPath (root repo shows the project folder name). */
  repoName: (repo: DiscoveredRepo) => string;
  /** The PR currently open in the content pane, for highlight. */
  activePr: { subPath: string; number: number } | null;
  onOpenPr: (subPath: string, number: number) => void;
}

/**
 * The right-sidebar PR list, laid out like the Diffs tab: a row per repo, each
 * lazily fetching ONLY its own PRs when expanded — so a folder of many repos
 * never fans out into a burst of `gh` calls that would risk rate-limiting.
 * A single-repo project auto-expands (there's nothing to choose between).
 *
 * Data is stale-while-revalidate (see pr-store): a repo repaints its last-known
 * PRs instantly, with a shimmer while a background refetch runs.
 */
export function PrSidebar({
  encoded,
  repos,
  repoName,
  activePr,
  onOpenPr,
}: Props) {
  const single = repos.length === 1;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(single ? [repos[0].subPath] : []),
  );

  // Keep the single-repo auto-expand correct if the repo set changes.
  useEffect(() => {
    if (single) setExpanded(new Set([repos[0].subPath]));
  }, [single, repos]);

  if (repos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
        No git repos
      </div>
    );
  }

  const toggle = (subPath: string) =>
    setExpanded((prev) => toggleInSet(prev, subPath));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {repos.map((repo) => {
        const open = expanded.has(repo.subPath);
        return (
          <div key={repo.subPath || "/"}>
            {!single && (
              <button
                onClick={() => toggle(repo.subPath)}
                className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface-hover)]"
              >
                <Chevron open={open} className="duration-150" />
                <span className="truncate">{repoName(repo)}</span>
              </button>
            )}
            {open && (
              <RepoPrList
                encoded={encoded}
                subPath={repo.subPath}
                activeNumber={
                  activePr?.subPath === repo.subPath ? activePr.number : null
                }
                onOpenPr={(n) => onOpenPr(repo.subPath, n)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One repo's PR list. Mounted only while expanded, so `usePrList(enabled)`
 * fetches lazily — collapsing a repo unmounts it and stops its revalidation. */
function RepoPrList({
  encoded,
  subPath,
  activeNumber,
  onOpenPr,
}: {
  encoded: string;
  subPath: string;
  activeNumber: number | null;
  onOpenPr: (number: number) => void;
}) {
  const { result, loading, revalidating } = usePrList(encoded, subPath, true);

  if (loading) {
    return <ShimmerRows />;
  }
  if (!result) {
    return (
      <Empty>
        <TextShimmer duration={2.4}>Loading…</TextShimmer>
      </Empty>
    );
  }
  if (!result.available) {
    return <Empty>{result.error ?? "No GitHub remote"}</Empty>;
  }
  if (result.prs.length === 0) {
    return <Empty>No open PRs</Empty>;
  }

  return (
    <div className={cn(revalidating && "opacity-70 transition-opacity")}>
      {result.prs.map((pr) => (
        <PrRow
          key={pr.number}
          pr={pr}
          active={pr.number === activeNumber}
          onClick={() => onOpenPr(pr.number)}
        />
      ))}
    </div>
  );
}

function PrRow({
  pr,
  active,
  onClick,
}: {
  pr: PrSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={pr.title}
      className={cn(
        "flex w-full flex-col gap-1 border-b border-[var(--border)] px-3 py-2 text-left transition-colors",
        active
          ? "bg-[var(--bg-surface-hover)]"
          : "hover:bg-[var(--bg-surface-hover)]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <StateDot state={pr.state} isDraft={pr.isDraft} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">
          {pr.title}
        </span>
        <ChecksDot checks={pr.checks} />
      </div>
      <div className="flex items-center gap-2 pl-3.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
        <span>#{pr.number}</span>
        <span className="truncate">{pr.headRefName}</span>
        {pr.authorIsBot && (
          <span className="rounded bg-[var(--bg-surface-hover)] px-1 py-0.5 uppercase tracking-wide">
            bot
          </span>
        )}
      </div>
    </button>
  );
}

function StateDot({
  state,
  isDraft,
}: {
  state: PrSummary["state"];
  isDraft: boolean;
}) {
  const color = isDraft
    ? "bg-[var(--text-tertiary)]"
    : state === "OPEN"
      ? "bg-emerald-500"
      : state === "MERGED"
        ? "bg-purple-500"
        : "bg-red-500";
  const label = isDraft ? "Draft" : state.toLowerCase();
  return (
    <span
      title={label}
      className={cn("h-2 w-2 shrink-0 rounded-full", color)}
    />
  );
}

/** Rolled-up CI state, or nothing when the PR has no checks. */
function ChecksDot({ checks }: { checks: PrSummary["checks"] }) {
  if (!checks) return null;
  const color =
    checks === "success"
      ? "text-emerald-500"
      : checks === "failure"
        ? "text-red-500"
        : "text-amber-500";
  const glyph = checks === "success" ? "✓" : checks === "failure" ? "✕" : "•";
  return (
    <span
      title={`Checks: ${checks}`}
      className={cn("shrink-0 text-[11px] leading-none", color)}
    >
      {glyph}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

/** Gray placeholder rows while a repo's list is fetched for the first time. */
function ShimmerRows() {
  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="h-3 w-3/4 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
          <div className="h-2 w-1/3 animate-pulse rounded bg-[var(--bg-surface-hover)]" />
        </div>
      ))}
    </div>
  );
}
