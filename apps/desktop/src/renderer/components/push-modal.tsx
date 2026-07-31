import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import type { GitOpResult, PushPreview } from "../../shared-types";

interface Props {
  /** Read before the dialog mounts, so it opens at its final size. */
  preview: PushPreview;
  /** Repo name, shown only when the project holds more than one repo. */
  repoLabel: string | null;
  onPush: () => Promise<GitOpResult>;
  /** Re-read after a failed push — the pull half may have changed the range. */
  onRefreshPreview: () => Promise<PushPreview>;
  onClose: () => void;
}

/**
 * Push approval gate for one repo. Shows the branch, the ref it lands on and
 * the commits git reports as pending, then runs the push on approval. Stays
 * open on failure with git's stderr — the sync bar used to swallow it.
 */
export function PushModal({
  preview: initialPreview,
  repoLabel,
  onPush,
  onRefreshPreview,
  onClose,
}: Props) {
  const [preview, setPreview] = useState(initialPreview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const publishing = !preview.upstream;
  const target = preview.upstream ?? preview.publishTarget;
  const blocked = !preview.available
    ? "Not a git repo."
    : !preview.branch
      ? "Detached HEAD — no branch to push."
      : !target
        ? "No origin remote configured."
        : null;
  const canPush = blocked === null && !busy;

  const submit = async () => {
    if (!canPush) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onPush();
      if (res.ok) {
        onClose();
        return;
      }
      setError(res.error ?? "Push failed.");
      setPreview(await onRefreshPreview());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        className="w-[420px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3.5 shadow-lg outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
          {publishing ? "Publish branch" : "Pull & push"}
        </div>
        <div className="mt-0.5 mb-2.5 flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {repoLabel && (
            <span className="truncate rounded-md border border-[var(--border-strong)] px-1.5 py-0.5 leading-none text-[var(--text-secondary)]">
              {repoLabel}
            </span>
          )}
          <span className="truncate">
            {preview.branch ?? "detached"} → {target ?? "no remote"}
          </span>
        </div>

        <CommitList preview={preview} />

        {blocked && (
          <div className="mt-2.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {blocked}
          </div>
        )}
        {error && (
          <div className="mt-2.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--diff-remove-bg)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[10px] leading-relaxed text-[var(--removed-text)]">
            {error}
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!canPush}
            className="gap-1.5"
          >
            {busy ? (
              publishing ? (
                "Publishing…"
              ) : (
                "Pushing…"
              )
            ) : (
              <>
                {publishing ? "Publish" : "Pull & push"}
                <Kbd keys={["⌘", "↵"]} />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The commits git reports as pending — never a count we inferred elsewhere. */
function CommitList({ preview }: { preview: PushPreview }) {
  if (preview.commits.length === 0) {
    return (
      <div className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
        No commits to send.
      </div>
    );
  }
  return (
    <div className="max-h-56 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] py-1">
      {preview.commits.map((c) => (
        <div
          key={c.sha}
          className="flex items-baseline gap-2 px-2.5 py-[3px] font-[family-name:var(--font-mono)] text-[11px] leading-5"
        >
          <span className="shrink-0 text-[var(--text-tertiary)]">{c.sha}</span>
          <span className="truncate text-[var(--text-secondary)]">
            {c.subject}
          </span>
        </div>
      ))}
      {preview.truncated && (
        <div className="px-2.5 py-[3px] font-[family-name:var(--font-mono)] text-[10px] leading-5 text-[var(--text-tertiary)]">
          More commits pending than shown.
        </div>
      )}
    </div>
  );
}
