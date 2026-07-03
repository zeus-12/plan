import { Language, Parser, Query } from "web-tree-sitter";
import {
  indentationFoldEngine,
  type CodeSymbol,
  type FoldEngine,
  type FoldRange,
} from "@plan/shared/code-folding";
import runtimeWasmUrl from "./tree-sitter.wasm?url";
import { FOLD_REGISTRY, type GrammarEntry } from "./registry";
import { foldRangesFromCaptures, symbolsFromMatches } from "./extract";

// Vite bundles each vendored asset and hands us its final URL (grammars) / text
// (queries). Lazy `Language.load` only fetches a grammar's wasm the first time a
// file of that language is opened.
const grammarUrls = import.meta.glob("./grammars/*.wasm", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const querySources = import.meta.glob("./queries/*.scm", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const tagsSources = import.meta.glob("./tags/*.scm", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let runtimeInit: Promise<void> | null = null;
const ensureRuntime = () =>
  (runtimeInit ??= Parser.init({ locateFile: () => runtimeWasmUrl }));

interface LoadedLanguage {
  language: Language;
  foldQuery: Query;
  /** Symbol (tags) query — only for languages with a vendored tags.scm. */
  tagsQuery: Query | null;
}
// One in-flight/resolved load per language id — shared across files.
const loaders = new Map<string, Promise<LoadedLanguage | null>>();

async function loadLanguage(
  entry: GrammarEntry,
): Promise<LoadedLanguage | null> {
  const url = grammarUrls[`./grammars/${entry.grammar}.wasm`];
  const source = querySources[`./queries/${entry.query}.scm`];
  if (!url || !source) return null;
  await ensureRuntime();
  const language = await Language.load(url);
  const tagsSrc = tagsSources[`./tags/${entry.query}.scm`];
  let tagsQuery: Query | null = null;
  if (tagsSrc) {
    try {
      tagsQuery = new Query(language, tagsSrc);
    } catch {
      tagsQuery = null; // a bad tags query just disables symbols for this lang
    }
  }
  return { language, foldQuery: new Query(language, source), tagsQuery };
}

/**
 * Tree-sitter-backed fold engine for the desktop app (the "preset"). It parses
 * the file and reads `@fold` captures from the vendored query. For any language
 * without a vendored grammar — or on any load/parse failure — it falls back to
 * {@link indentationFoldEngine}, so folding never breaks.
 *
 * Swappability: this engine is referenced in exactly one place
 * (`FoldEngineProvider` in `main.tsx`). Delete this folder + that one wrap and
 * the whole app reverts to indentation folding.
 */
function loadFor(languageId: string): Promise<LoadedLanguage | null> {
  const entry = FOLD_REGISTRY[languageId];
  if (!entry) return Promise.resolve(null);
  let loader = loaders.get(languageId);
  if (!loader) {
    loader = loadLanguage(entry);
    loaders.set(languageId, loader);
  }
  return loader;
}

export const treeSitterFoldEngine: FoldEngine = {
  name: "tree-sitter",
  async computeFolds(text: string, languageId: string): Promise<FoldRange[]> {
    try {
      const loaded = await loadFor(languageId);
      if (!loaded) return indentationFoldEngine.computeFolds(text, languageId);
      const parser = new Parser();
      parser.setLanguage(loaded.language);
      const tree = parser.parse(text);
      if (!tree) {
        parser.delete();
        return indentationFoldEngine.computeFolds(text, languageId);
      }
      const ranges = foldRangesFromCaptures(
        loaded.foldQuery.captures(tree.rootNode),
      );
      tree.delete();
      parser.delete();
      return ranges;
    } catch {
      return indentationFoldEngine.computeFolds(text, languageId);
    }
  },
  async computeSymbols(
    text: string,
    languageId: string,
  ): Promise<CodeSymbol[]> {
    try {
      const loaded = await loadFor(languageId);
      if (!loaded?.tagsQuery) return [];
      const parser = new Parser();
      parser.setLanguage(loaded.language);
      const tree = parser.parse(text);
      if (!tree) {
        parser.delete();
        return [];
      }
      const symbols = symbolsFromMatches(
        loaded.tagsQuery.matches(tree.rootNode),
      );
      tree.delete();
      parser.delete();
      return symbols;
    } catch {
      return [];
    }
  },
};
