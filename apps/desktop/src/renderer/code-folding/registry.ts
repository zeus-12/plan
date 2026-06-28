/**
 * Language id (the Shiki ids `languageFromPath` returns) → vendored tree-sitter
 * grammar + fold query. To add a language: drop its `grammars/<grammar>.wasm`
 * and `queries/<query>.scm` in, then add a line here. To drop one: remove its
 * line (and optionally its assets). Languages absent here fall back to
 * indentation folding automatically.
 */
export interface GrammarEntry {
  /** Basename of the grammar wasm in ./grammars (without extension). */
  grammar: string;
  /** Basename of the fold query in ./queries (without extension). */
  query: string;
}

export const FOLD_REGISTRY: Record<string, GrammarEntry> = {
  javascript: { grammar: "javascript", query: "javascript" },
  jsx: { grammar: "javascript", query: "javascript" },
  typescript: { grammar: "typescript", query: "typescript" },
  tsx: { grammar: "tsx", query: "tsx" },
  python: { grammar: "python", query: "python" },
  rust: { grammar: "rust", query: "rust" },
  go: { grammar: "go", query: "go" },
  java: { grammar: "java", query: "java" },
  c: { grammar: "c", query: "c" },
  cpp: { grammar: "cpp", query: "cpp" },
  csharp: { grammar: "c_sharp", query: "c_sharp" },
  ruby: { grammar: "ruby", query: "ruby" },
  php: { grammar: "php", query: "php" },
  swift: { grammar: "swift", query: "swift" },
  kotlin: { grammar: "kotlin", query: "kotlin" },
  scala: { grammar: "scala", query: "scala" },
  bash: { grammar: "bash", query: "bash" },
  shellscript: { grammar: "bash", query: "bash" },
  html: { grammar: "html", query: "html" },
  css: { grammar: "css", query: "css" },
  json: { grammar: "json", query: "json" },
  yaml: { grammar: "yaml", query: "yaml" },
};
