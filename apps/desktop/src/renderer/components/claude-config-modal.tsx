import { useEffect, useMemo, useState } from "react";
import { Button } from "@plan/shared/components/ui/button";
import { Kbd } from "@plan/shared/components/ui/kbd";
import { CodeEditor } from "@plan/shared/components/code-editor";
import { cn } from "@plan/shared/lib/utils";
import type {
  ClaudeConfigBundle,
  ClaudeConfigFile,
  ClaudeConfigScope,
} from "../../shared-types";

interface Props {
  /** Active project; null shows only the global file. */
  encoded: string | null;
  /** Which section to focus when the modal opens. */
  initialScope: ClaudeConfigScope;
  onClose: () => void;
}

const SCOPE_LABELS: Record<ClaudeConfigScope, string> = {
  global: "Global",
  project: "Project",
  memory: "Memory",
};

const SCOPE_HINTS: Record<ClaudeConfigScope, string> = {
  global: "Applies to every project on this machine.",
  project:
    "The CLAUDE.md cascade — every file from this project up to the root applies, additively.",
  memory: "Per-project memory Claude maintains across sessions.",
};

/**
 * View and edit the files that steer Claude for a project: the global
 * ~/.claude/CLAUDE.md, the project CLAUDE.md cascade (cwd → root), and the
 * per-project memory store. Opened from the left sidebar (global) or from the
 * right sidebar next to Search (project + memory).
 */
export function ClaudeConfigModal({ encoded, initialScope, onClose }: Props) {
  const [bundle, setBundle] = useState<ClaudeConfigBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  /** Live edit buffers keyed by path. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** On-disk contents, for dirty detection; updated after a successful save. */
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Flat, ordered list mirroring the visual grouping.
  const entries: ClaudeConfigFile[] = useMemo(() => {
    if (!bundle) return [];
    return [bundle.global, ...bundle.project, ...bundle.memory];
  }, [bundle]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .readClaudeConfig(encoded)
      .then((b) => {
        if (cancelled) return;
        setBundle(b);
        const all = [b.global, ...b.project, ...b.memory];
        setDrafts(Object.fromEntries(all.map((f) => [f.path, f.text])));
        setSaved(Object.fromEntries(all.map((f) => [f.path, f.text])));
        setExists(Object.fromEntries(all.map((f) => [f.path, f.exists])));
        // Focus the requested section; fall back to the global file.
        const pick =
          all.find((f) => f.scope === initialScope) ?? all[0] ?? null;
        setActivePath(pick?.path ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [encoded, initialScope]);

  const active = entries.find((f) => f.path === activePath) ?? null;
  const activeDraft = active ? (drafts[active.path] ?? "") : "";
  const dirty = active ? activeDraft !== (saved[active.path] ?? "") : false;

  const select = (path: string) => {
    setActivePath(path);
    setSaveError(null);
    setJustSaved(false);
  };

  const save = async () => {
    if (!active || !dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      // Only reflect success after the write actually resolves — never assume.
      await window.electronAPI.writeClaudeConfig(active.path, activeDraft);
      setSaved((p) => ({ ...p, [active.path]: activeDraft }));
      setExists((p) => ({ ...p, [active.path]: true }));
      setJustSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderGroup = (scope: ClaudeConfigScope, files: ClaudeConfigFile[]) => (
    <div key={scope} className="mb-3">
      <div className="px-2 pb-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        {SCOPE_LABELS[scope]}
      </div>
      {files.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-[var(--text-tertiary)]">
          {scope === "memory" ? "No memory yet." : "None."}
        </div>
      ) : (
        files.map((f) => {
          const isDirty = (drafts[f.path] ?? "") !== (saved[f.path] ?? "");
          return (
            <button
              key={f.path}
              onClick={() => select(f.path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-[family-name:var(--font-mono)] text-[11px] transition-colors",
                f.path === activePath
                  ? "bg-[var(--bg-surface-hover)] text-[var(--text)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]",
              )}
              title={f.label}
            >
              <span className="min-w-0 flex-1 truncate">{f.label}</span>
              {isDirty && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
              )}
              {!exists[f.path] && (
                <span className="shrink-0 text-[9px] uppercase text-[var(--text-tertiary)]">
                  new
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex h-[560px] w-[860px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
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
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <div className="font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--text)]">
            Claude instructions & memory
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--text-tertiary)] transition-colors hover:text-[var(--text)]"
          >
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
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {loadError ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-[var(--text-tertiary)]">
            Couldn’t read config files: {loadError}
          </div>
        ) : !bundle ? (
          <div className="flex flex-1 items-center justify-center text-[11px] text-[var(--text-tertiary)]">
            Loading…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Left: the hierarchy. */}
            <div className="w-[260px] shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
              {renderGroup("global", [bundle.global])}
              {renderGroup("project", bundle.project)}
              {renderGroup("memory", bundle.memory)}
            </div>

            {/* Right: editor for the selected file. */}
            <div className="flex min-w-0 flex-1 flex-col">
              {active ? (
                <>
                  <div className="border-b border-[var(--border)] px-4 py-2">
                    <div className="truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--text)]">
                      {active.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                      {SCOPE_HINTS[active.scope]}
                      {!exists[active.path] &&
                        " — doesn’t exist yet; saving creates it."}
                    </div>
                  </div>
                  {/* Editable + Shiki-highlighted (markdown grammar), sharing
                      the app's single highlighter instance. */}
                  <div className="min-h-0 flex-1 overflow-hidden p-3">
                    <CodeEditor
                      value={activeDraft}
                      onChange={(v) => {
                        setDrafts((p) => ({ ...p, [active.path]: v }));
                        setJustSaved(false);
                        setSaveError(null);
                      }}
                      language="markdown"
                      placeholder="Empty — type to add instructions…"
                      minHeight="100%"
                      maxHeight="100%"
                      className="h-full"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5">
                    <div className="min-w-0 truncate text-[11px]">
                      {saveError ? (
                        <span className="text-[var(--danger,#e5484d)]">
                          {saveError}
                        </span>
                      ) : justSaved && !dirty ? (
                        <span className="text-[var(--text-tertiary)]">
                          Saved
                        </span>
                      ) : dirty ? (
                        <span className="text-[var(--text-tertiary)]">
                          Unsaved changes
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={onClose}>
                        Close
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void save()}
                        disabled={!dirty || saving}
                      >
                        {saving ? (
                          "Saving…"
                        ) : (
                          <>
                            Save
                            <Kbd keys={["⌘", "↵"]} />
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center text-[11px] text-[var(--text-tertiary)]">
                  Select a file
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
