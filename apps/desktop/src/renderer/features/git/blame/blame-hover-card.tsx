import { useEffect, useState } from "react";
import type { BlameCommit, CommitDetails } from "@/common/shared-types";
import { relativeTime } from "@/renderer/lib/time";

// Commit messages are immutable, so one fetch per (project, hash) per app run.
const detailsCache = new Map<string, CommitDetails | null>();

interface Props {
  encoded: string;
  /** Project-relative path of the blamed file (locates the right repo). */
  path: string;
  /** Base info from the blame pass — shown instantly while details load. */
  commit: BlameCommit | null;
  uncommitted: boolean;
  isYou: boolean;
  position: { top: number; left: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * Hover card for an inline blame annotation: author, date, and the full
 * commit message (fetched lazily — the blame pass only carries the subject).
 */
export function BlameHoverCard({
  encoded,
  path,
  commit,
  uncommitted,
  isYou,
  position,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const hash = commit?.hash ?? "";
  const cacheKey = `${encoded}\0${hash}`;
  const [details, setDetails] = useState<CommitDetails | null>(
    () => detailsCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    if (uncommitted || !hash) return;
    const cached = detailsCache.get(cacheKey);
    if (cached !== undefined) {
      setDetails(cached);
      return;
    }
    let cancelled = false;
    window.electronAPI.commitDetails(encoded, path, hash).then((d) => {
      detailsCache.set(cacheKey, d);
      if (!cancelled) setDetails(d);
    });
    return () => {
      cancelled = true;
    };
  }, [encoded, path, hash, uncommitted, cacheKey]);

  const time = commit?.authorTime ?? 0;
  const url = details?.url ?? null;
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 w-[400px] max-w-[calc(100vw-16px)] rounded-md border border-[var(--border)] bg-[var(--bg)] font-[family-name:var(--font-mono)] shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      <div className="flex items-baseline gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="truncate text-[12px] text-[var(--text)]">
          {uncommitted ? "Uncommitted changes" : commit?.author}
          {!uncommitted && isYou && (
            <span className="text-[var(--text-tertiary)]"> (You)</span>
          )}
        </span>
        {!uncommitted &&
          (url ? (
            <button
              type="button"
              title={url}
              onClick={() => window.electronAPI.openCommit(url)}
              className="ml-auto shrink-0 cursor-pointer text-[11px] text-[var(--text-tertiary)] underline-offset-2 hover:text-[var(--text)] hover:underline"
            >
              {hash.slice(0, 7)}
            </button>
          ) : (
            <span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">
              {hash.slice(0, 7)}
            </span>
          ))}
      </div>
      {uncommitted ? (
        <div className="px-3 py-2 text-[11px] text-[var(--text-tertiary)]">
          These lines aren&apos;t committed yet.
        </div>
      ) : (
        <>
          <div className="px-3 pt-2 text-[11px] text-[var(--text-tertiary)]">
            {relativeTime(time)}
            {time > 0 && ` (${new Date(time).toLocaleString()})`}
          </div>
          <div className="max-h-[280px] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[12px] leading-[18px] text-[var(--text)]">
            {details?.message ?? commit?.summary ?? ""}
          </div>
        </>
      )}
    </div>
  );
}
