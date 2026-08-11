import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { basename } from "@plan/shared/lib/path";
import type { SentFile } from "@/common/shared-types";
import { OpenPathMenu } from "@/renderer/features/external-apps/open-in-menu";
import { sentFilePreview } from "./sent-file";
import {
  ToolPreviewCard,
  useToolPreviewHover,
  type ToolPreview,
} from "./tool-preview-card";

/**
 * A SendUserFile call, as one transcript row per file.
 *
 * It keeps the grammar of every other tool row — muted verb, target, one line —
 * and adds only what the row can't do without: the caption the call was written
 * with, and an "Open in…" control for a file that lives outside every workspace.
 * The control sits in the line at rest rather than appearing under the cursor;
 * hover is left to the preview card, which is the same card a Read or an Edit
 * opens. Nothing here reads the file until that hover means it.
 */

/** The file's own read, fetched on hover intent and kept for this row's life. */
function useSentFile(path: string, wanted: boolean) {
  // undefined = not read yet, null = nothing readable there.
  const [file, setFile] = useState<SentFile | null | undefined>(undefined);

  useEffect(() => {
    if (!wanted || file !== undefined) return;
    let live = true;
    window.electronAPI
      .readSentFile(path)
      .then((res) => live && setFile(res))
      .catch(() => live && setFile(null));
    return () => {
      live = false;
    };
  }, [wanted, file, path]);

  return file;
}

function FileRow({
  path,
  caption,
  indented,
}: {
  path: string;
  caption?: string;
  indented?: boolean;
}) {
  const hover = useToolPreviewHover();
  const [wanted, setWanted] = useState(false);
  const file = useSentFile(path, wanted);

  const preview = useMemo((): ToolPreview | null => {
    if (!file) return null;
    return sentFilePreview(path, file);
  }, [file, path]);

  return (
    <div
      className={`flex w-full items-center gap-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] ${
        indented ? "pl-4" : ""
      }`}
    >
      <span
        className="flex min-w-0 items-center gap-1.5"
        onMouseEnter={(e) => {
          setWanted(true);
          hover.onEnter(e.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={hover.onLeave}
      >
        {!indented && (
          <span className="shrink-0 text-[var(--text-tertiary)]">Sent</span>
        )}
        <span className="shrink-0 text-[var(--text-secondary)]">
          {/* Explicit space so a comment spanning this row reads "Sent <name>",
              not "Sent<name>" — flex collapses it visually, textContent keeps it. */}{" "}
          {basename(path)}
        </span>
        {caption && (
          <span className="min-w-0 truncate text-[var(--text-tertiary)]">
            {" "}
            {caption}
          </span>
        )}
      </span>
      {/* Held back until the read confirms the file is there: offering to open
          something that has since been deleted is a promise we can't keep. */}
      {file !== null && (
        <span className="shrink-0" data-find-skip="" data-anno-skip="">
          <OpenPathMenu path={path} compact />
        </span>
      )}
      {preview &&
        hover.anchor &&
        createPortal(
          <ToolPreviewCard
            preview={preview}
            anchor={hover.anchor}
            onMouseEnter={hover.onCardEnter}
            onMouseLeave={hover.onCardLeave}
          />,
          document.body,
        )}
    </div>
  );
}

export function SentFileBlock({
  files,
  caption,
}: {
  files: string[];
  caption: string;
}) {
  if (files.length === 1) {
    return <FileRow path={files[0]} caption={caption} />;
  }
  return (
    <div>
      <div className="flex w-full items-center gap-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px]">
        <span className="shrink-0 text-[var(--text-tertiary)]">Sent</span>
        <span className="shrink-0 text-[var(--text-secondary)]">
          {" "}
          {files.length} files
        </span>
        {caption && (
          <span className="min-w-0 truncate text-[var(--text-tertiary)]">
            {" "}
            {caption}
          </span>
        )}
      </div>
      {files.map((f) => (
        <FileRow key={f} path={f} indented />
      ))}
    </div>
  );
}
