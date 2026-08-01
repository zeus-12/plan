import { useEffect, useMemo, useRef, useState } from "react";
import { FileViewer } from "@/renderer/features/files/file-viewer";
import type { Annotation } from "@plan/shared/lib/comments/store";
import { LANGUAGES, prettify, detectJson } from "./scratch-languages";
import { pushToast } from "@/renderer/lib/toast-store";

const NO_ANNOTATIONS: Annotation[] = [];
const noop = () => {};

/**
 * Per-worktree scratchpad — a full editable buffer rendered through {@link
 * FileViewer}, so it gets the exact file-tab surface: Shiki highlighting, line
 * numbers, code folding, line wrap, sticky scroll, bracket colors and ⌘F find —
 * just editable. Content + language persist to disk per `encoded` (see
 * main/scratch-store), surviving quit/relaunch, off the localStorage quota the
 * tab state lives in.
 *
 * Reusing FileViewer (rather than a bespoke editor) is deliberate: it's the same
 * surface files already use, and the `buffer` seam we lean on here is the path to
 * making real files editable later.
 */
export function ScratchEditor({
  encoded,
  active,
}: {
  encoded: string;
  active: boolean;
}) {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("plaintext");
  // Gate persistence until the initial disk read lands, so the empty first
  // render never clobbers saved content.
  const [loaded, setLoaded] = useState(false);

  // Load once per worktree.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    window.electronAPI.readScratch(encoded).then((data) => {
      if (cancelled) return;
      const content = data?.content ?? "";
      let lang = data?.language ?? "plaintext";
      // Only JSON is detected with certainty; everything else is the manual
      // picker (no guessed string-matching that could mislabel the language).
      if ((!data || lang === "plaintext") && detectJson(content)) lang = "json";
      setText(content);
      setLanguage(lang);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [encoded]);

  // Debounced persistence.
  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      void window.electronAPI.writeScratch(encoded, {
        content: text,
        language,
      });
    }, 400);
    return () => clearTimeout(id);
  }, [text, language, loaded, encoded]);

  const runPrettify = async () => {
    if (!text.trim()) return;
    const res = await prettify(text, language);
    if (!res.ok) {
      pushToast({ title: "Couldn't format", description: res.error });
      return;
    }
    if (res.text !== text) setText(res.text);
  };

  const canFormat = !!LANGUAGES.find((l) => l.id === language)?.formattable;

  const buffer = useMemo(
    () => ({
      value: text,
      onChange: setText,
      language,
      onLanguageChange: setLanguage,
      title: "Scratchpad",
      languages: LANGUAGES,
      onFormat: () => void runPrettify(),
      canFormat,
    }),
    // runPrettify closes over the latest text/language via the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, language, canFormat],
  );

  // Wait for the disk read before mounting the editor, so it comes up with the
  // saved content in place — the caret lands at the true end (last line), not at
  // the end of an empty buffer that then fills in underneath it.
  if (!loaded) return <div className="h-full w-full bg-[var(--bg)]" />;

  return (
    <FileViewer
      encoded={encoded}
      path=""
      annotations={NO_ANNOTATIONS}
      onAddAnnotation={noop}
      onUpdateAnnotation={noop}
      onRemoveAnnotation={noop}
      active={active}
      buffer={buffer}
    />
  );
}
