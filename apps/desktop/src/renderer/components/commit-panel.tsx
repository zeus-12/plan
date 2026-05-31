import { useCallback, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import { cn } from "@plan/shared/lib/utils";

interface Props {
  stagedCount: number;
  branch: string | null;
  /** Repo name to display next to "Commit · N files" — null hides it (single-repo project). */
  repoLabel: string | null;
  onCommit: (message: string) => Promise<{ ok: boolean; error?: string }>;
}

export function CommitPanel({
  stagedCount,
  branch,
  repoLabel,
  onCommit,
}: Props) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!message.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await onCommit(message);
      if (res.ok) {
        setMessage("");
      } else {
        setError(res.error ?? "Commit failed");
      }
    } finally {
      setPending(false);
    }
  }, [message, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)] p-2.5">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          repoLabel
            ? `Message (${repoLabel}) — ⌘Enter to commit`
            : "Message — ⌘Enter to commit"
        }
        rows={2}
        className={cn(
          "w-full resize-y rounded-md border p-2 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed",
          "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]",
          "placeholder:text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-strong)]"
        )}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
          {error ? (
            <span className="text-[var(--removed-text)]">{error}</span>
          ) : (
            <>
              {branch ? `⎇ ${branch} · ` : ""}
              {stagedCount} staged
            </>
          )}
        </span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={pending || !message.trim()}
        >
          {pending ? "Committing…" : "Commit"}
        </Button>
      </div>
    </div>
  );
}
