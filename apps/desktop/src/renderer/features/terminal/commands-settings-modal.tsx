import { useEffect, useRef, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@plan/shared/components/ui/tabs";
import type { CommandEntry, DiscoveredRepo } from "@/common/shared-types";
import { newEntryId } from "./commands";

export type CommandSection = "run" | "build";

interface Props {
  /** Which section opens first — the gear passes the active terminal tab's. */
  section: CommandSection;
  runEntries: CommandEntry[];
  buildEntries: CommandEntry[];
  /** Sub-repos of the project — populate the per-row target dropdown (multi-repo only). */
  repos: DiscoveredRepo[];
  /** Outside a worktree the Build tab isn't shown, so its section says so. */
  isWorktree: boolean;
  /** Persist a list (empty commands dropped). Shared across worktrees + sessions. */
  onSaveRun: (entries: CommandEntry[]) => Promise<void> | void;
  onSaveBuild: (entries: CommandEntry[]) => Promise<void> | void;
  onClose: () => void;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-strong)]";
const selectCls =
  "shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]";

function repoName(subPath: string): string {
  return subPath.split("/").pop() || subPath;
}

/** A blank row so a section is never an empty void; dropped on save if untouched. */
function blankRows(entries: CommandEntry[]): CommandEntry[] {
  return entries.length > 0
    ? entries.map((e) => ({ ...e }))
    : [{ id: newEntryId(), command: "" }];
}

/** Commands minus the blank rows — what actually gets persisted. */
function cleanRows(rows: CommandEntry[]): CommandEntry[] {
  return rows
    .filter((r) => r.command.trim() !== "")
    .map((r) => ({
      id: r.id,
      command: r.command.trim(),
      ...(r.subPath ? { subPath: r.subPath } : {}),
    }));
}

function sameEntries(a: CommandEntry[], b: CommandEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function CommandRows({
  rows,
  setRows,
  repos,
  placeholder,
}: {
  rows: CommandEntry[];
  setRows: (next: CommandEntry[]) => void;
  repos: DiscoveredRepo[];
  placeholder: string;
}) {
  const multiRepo = repos.length > 1;
  const firstRef = useRef<HTMLInputElement>(null);

  // Radix unmounts the inactive tab, so this fires on open and on each switch —
  // the caret lands in the section you're looking at.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const setRow = (id: string, patch: Partial<CommandEntry>) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={row.id} className="flex items-center gap-2">
          {multiRepo && (
            <select
              value={row.subPath ?? ""}
              onChange={(e) =>
                setRow(row.id, { subPath: e.target.value || undefined })
              }
              className={selectCls}
              title="Run this command in…"
            >
              <option value="">root</option>
              {repos
                .filter((r) => r.subPath)
                .map((r) => (
                  <option key={r.subPath} value={r.subPath}>
                    {repoName(r.subPath)}
                  </option>
                ))}
            </select>
          )}
          <input
            ref={i === 0 ? firstRef : undefined}
            value={row.command}
            onChange={(e) => setRow(row.id, { command: e.target.value })}
            placeholder={placeholder}
            className={inputCls}
          />
          <button
            onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
            disabled={rows.length === 1}
            title="Remove command"
            aria-label="Remove command"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[16px] leading-none text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30"
          >
            ×
          </button>
        </div>
      ))}

      <button
        onClick={() => setRows([...rows, { id: newEntryId(), command: "" }])}
        className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
      >
        <span className="text-[14px] leading-none">+</span>
        Add command
      </button>
    </div>
  );
}

/**
 * The one place a project's terminal commands are configured, reached from the
 * single gear pinned in the terminal tab strip. Each section is a command list;
 * a row optionally binds to a git sub-repo (its cwd) when the project spans
 * several repos. Both lists are project-level (shared across worktrees +
 * sessions); only the running processes are per-worktree. Save writes only the
 * sections that actually changed.
 */
export function CommandsSettingsModal({
  section,
  runEntries,
  buildEntries,
  repos,
  isWorktree,
  onSaveRun,
  onSaveBuild,
  onClose,
}: Props) {
  const [tab, setTab] = useState<CommandSection>(section);
  const [runRows, setRunRows] = useState<CommandEntry[]>(() =>
    blankRows(runEntries),
  );
  const [buildRows, setBuildRows] = useState<CommandEntry[]>(() =>
    blankRows(buildEntries),
  );
  const [busy, setBusy] = useState(false);
  // Whether the press that's now finishing started on the backdrop. Closing on
  // a bare click is wrong: switching sections changes the card's height, the
  // card re-centres mid-press, and the pointer that went down on a tab comes up
  // over the backdrop — so the browser resolves the click to the two's common
  // ancestor, the backdrop, and the modal dismisses itself. Same for a text
  // selection dragged past the card's edge.
  const pressedBackdrop = useRef(false);

  const save = async () => {
    setBusy(true);
    const run = cleanRows(runRows);
    const build = cleanRows(buildRows);
    if (!sameEntries(run, runEntries)) await onSaveRun(run);
    if (!sameEntries(build, buildEntries)) await onSaveBuild(build);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
      }}
    >
      <div
        className="w-[520px] rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 shadow-lg"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as CommandSection)}
          className="flex flex-col"
        >
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
                Commands
              </span>
              <span className="text-[11px] leading-snug text-[var(--text-tertiary)]">
                {tab === "build" && !isWorktree
                  ? "Worktree only — the Build terminal shows up once you're in one. Set it here and it's ready."
                  : "Shared across every worktree and session of this project."}
              </span>
            </div>
            <TabsList className="shrink-0">
              <TabsTrigger value="run">Run</TabsTrigger>
              <TabsTrigger value="build">Build</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="run">
            <CommandRows
              rows={runRows}
              setRows={setRunRows}
              repos={repos}
              placeholder="npm run dev"
            />
          </TabsContent>

          <TabsContent value="build">
            <CommandRows
              rows={buildRows}
              setRows={setBuildRows}
              repos={repos}
              placeholder="npm run build"
            />
          </TabsContent>
        </Tabs>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
