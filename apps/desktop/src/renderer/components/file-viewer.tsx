import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  highlightPerLine,
  languageFromPath,
  useShikiReady,
  type SyntaxToken,
} from "@plan/shared/lib/highlight";

const LINE_HEIGHT = 20;

interface Props {
  encoded: string;
  /** Project-relative POSIX path. */
  path: string;
}

interface Loaded {
  text: string;
  truncated: boolean;
  binary: boolean;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Tokens carry dual light/dark colors; the global `.shiki-tok` rule picks one. */
function lineNodes(line: string, tokens: SyntaxToken[] | undefined): ReactNode {
  if (!tokens || tokens.length === 0) return line.length ? line : " ";
  const out: ReactNode[] = [];
  let cur = 0;
  tokens.forEach((t, i) => {
    if (t.start > cur) out.push(line.slice(cur, t.start));
    const style: Record<string, string | number> = {};
    if (t.lightColor) style["--shiki-light"] = t.lightColor;
    if (t.darkColor) style["--shiki-dark"] = t.darkColor;
    if (t.italic) style.fontStyle = "italic";
    if (t.bold) style.fontWeight = 600;
    out.push(
      <span
        key={i}
        className={t.lightColor || t.darkColor ? "shiki-tok" : undefined}
        style={style as React.CSSProperties}
      >
        {line.slice(t.start, t.end)}
      </span>
    );
    cur = t.end;
  });
  if (cur < line.length) out.push(line.slice(cur));
  return out;
}

export function FileViewer({ encoded, path }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">("loading");
  const shikiReady = useShikiReady();
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    window.electronAPI.readProjectFile(encoded, path).then((res) => {
      if (cancelled) return;
      if (!res) {
        setStatus("missing");
      } else {
        setData(res);
        setStatus("ok");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [encoded, path]);

  const language = useMemo(() => languageFromPath(path) ?? "plaintext", [path]);
  const lines = useMemo(() => (data?.text ?? "").split("\n"), [data?.text]);
  const perLine = useMemo(
    () =>
      data && !data.binary ? highlightPerLine(data.text, language) : [],
    // shikiReady is a dep so colors appear once the highlighter finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, language, shikiReady]
  );

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 30,
  });

  const gutterCh = Math.max(2, String(lines.length).length) + 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2 font-[family-name:var(--font-mono)] text-[11px]">
        <span className="truncate text-[var(--text)]">{basename(path)}</span>
        <span className="truncate text-[var(--text-tertiary)]">{path}</span>
        {data?.truncated && (
          <span className="ml-auto shrink-0 text-[var(--text-tertiary)]">
            truncated
          </span>
        )}
      </div>

      {status === "loading" ? (
        <Centered>Loading…</Centered>
      ) : status === "missing" ? (
        <Centered>File not found</Centered>
      ) : data?.binary ? (
        <Centered>Binary file — can&apos;t preview</Centered>
      ) : (
        <div
          ref={parentRef}
          className="min-h-0 flex-1 overflow-auto font-[family-name:var(--font-mono)] text-[13px] leading-[20px]"
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "max-content",
              minWidth: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const line = lines[vi.index];
              return (
                <div
                  key={vi.key}
                  className="absolute left-0 top-0 flex w-full"
                  style={{ height: LINE_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <span
                    className="sticky left-0 z-10 shrink-0 select-none bg-[var(--bg)] pr-3 pl-4 text-right text-[var(--text-tertiary)]"
                    style={{ width: `${gutterCh}ch` }}
                  >
                    {vi.index + 1}
                  </span>
                  <span className="whitespace-pre pr-6 text-[var(--text)]">
                    {lineNodes(line, perLine[vi.index])}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
