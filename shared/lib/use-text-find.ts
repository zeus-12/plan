import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

/** VS Code-style match options for the in-view find widget. */
export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One match, as absolute character offsets into the searched text. */
export interface FindMatch {
  start: number;
  end: number;
}

const MAX_MATCHES = 100_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile the query to a RegExp matching VS Code's toggle semantics. */
export function buildFindRegex(query: string, opts: FindOptions): RegExp {
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, opts.caseSensitive ? "g" : "gi");
}

/** Every match of `query` in `text`. Empty/invalid query → no matches. */
export function computeMatches(
  text: string,
  query: string,
  opts: FindOptions
): FindMatch[] {
  if (!query) return [];
  let re: RegExp;
  try {
    re = buildFindRegex(query, opts);
  } catch {
    return [];
  }
  const out: FindMatch[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

export interface TextFind {
  open: boolean;
  query: string;
  options: FindOptions;
  matches: FindMatch[];
  /** Index of the active match (0-based), or -1 when there are none. */
  current: number;
  setQuery: (q: string) => void;
  toggle: (key: keyof FindOptions) => void;
  /** Open the widget; optionally seed the query (e.g. from a selection). */
  show: (seed?: string) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
}

/**
 * State machine for an in-view find widget over a known `text`. Surfaces own
 * how to paint {@link TextFind.matches} and scroll {@link TextFind.current} into
 * view; this hook owns the query, options, match list, and cursor. Matching runs
 * off a deferred query so typing stays smooth on large files.
 */
export function useTextFind(text: string): TextFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [current, setCurrent] = useState(0);

  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(
    () => (open ? computeMatches(text, deferredQuery, options) : []),
    [open, text, deferredQuery, options]
  );

  // New query/options → jump back to the first match.
  useEffect(() => {
    setCurrent(0);
  }, [deferredQuery, options]);

  const toggle = useCallback(
    (key: keyof FindOptions) =>
      setOptions((o) => ({ ...o, [key]: !o[key] })),
    []
  );

  const show = useCallback((seed?: string) => {
    setOpen(true);
    if (seed != null && seed !== "") setQuery(seed);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const next = useCallback(() => {
    setCurrent((c) => (matches.length ? (c + 1) % matches.length : 0));
  }, [matches.length]);

  const prev = useCallback(() => {
    setCurrent((c) =>
      matches.length ? (c - 1 + matches.length) % matches.length : 0
    );
  }, [matches.length]);

  return {
    open,
    query,
    options,
    matches,
    current: matches.length ? Math.min(current, matches.length - 1) : -1,
    setQuery,
    toggle,
    show,
    close,
    next,
    prev,
  };
}
