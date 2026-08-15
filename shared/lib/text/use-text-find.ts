import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  opts: FindOptions,
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
  /** Increments on next/prev only, so a surface can scroll on navigation
   *  without scrolling on every keystroke. */
  navSeq: number;
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
 * State machine for an in-view find widget over some `source` text. Surfaces own
 * how to paint {@link TextFind.matches} and scroll {@link TextFind.current} into
 * view; this hook owns the query, options, match list, and cursor. Matching runs
 * off a deferred query so typing stays smooth on large files.
 *
 * `source` may be a string or a `() => string` provider. The provider is only
 * invoked while the widget is open, so callers whose searchable text is
 * expensive to assemble (e.g. joining thousands of diff lines) pay nothing until
 * the user actually opens find. Pass a memoized callback so its identity only
 * changes when the underlying text does.
 */
export function useTextFind(
  source: string | (() => string),
  /** Which match to select when the query or options change. Editors land on
   *  the match nearest what you are looking at rather than the top of the
   *  document; without this every keystroke jumps to the first result. */
  pickInitial?: (matches: FindMatch[]) => number,
): TextFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [current, setCurrent] = useState(0);
  // Bumped only by next/prev. Typing reselects the nearest match so the count
  // reads correctly, but must not drag the view somewhere else mid-word.
  const [navSeq, setNavSeq] = useState(0);

  // Only materialize the searchable text while open; closed find does no work
  // even as the underlying content (source identity) changes.
  const text = useMemo(
    () => (open ? (typeof source === "function" ? source() : source) : ""),
    [open, source],
  );

  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(
    () => (open ? computeMatches(text, deferredQuery, options) : []),
    [open, text, deferredQuery, options],
  );

  // New query/options → reselect. `pickInitial` is read through a ref so a
  // caller can pass an inline function without re-running this every render.
  const pickRef = useRef(pickInitial);
  pickRef.current = pickInitial;
  useEffect(() => {
    setCurrent(matches.length ? (pickRef.current?.(matches) ?? 0) : 0);
  }, [deferredQuery, options, matches]);

  const toggle = useCallback(
    (key: keyof FindOptions) => setOptions((o) => ({ ...o, [key]: !o[key] })),
    [],
  );

  const show = useCallback((seed?: string) => {
    setOpen(true);
    // A fresh find session must not replay the last navigation of the previous
    // one, which would scroll to a match from minutes ago.
    setNavSeq(0);
    if (seed != null && seed !== "") setQuery(seed);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const next = useCallback(() => {
    setCurrent((c) => (matches.length ? (c + 1) % matches.length : 0));
    setNavSeq((n) => n + 1);
  }, [matches.length]);

  const prev = useCallback(() => {
    setCurrent((c) =>
      matches.length ? (c - 1 + matches.length) % matches.length : 0,
    );
    setNavSeq((n) => n + 1);
  }, [matches.length]);

  return {
    open,
    query,
    options,
    matches,
    navSeq,
    current: matches.length ? Math.min(current, matches.length - 1) : -1,
    setQuery,
    toggle,
    show,
    close,
    next,
    prev,
  };
}
