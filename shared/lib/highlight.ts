import { createLowlight, common } from "lowlight";

// Re-export shiki tokens as our canonical SyntaxToken shape so existing
// callers don't have to know which engine produced them.
export {
  highlightTokens,
  highlightPerLine,
  highlightToHtml,
  stripComments,
  ensureHighlighter,
  useShikiReady,
  setActiveShikiTheme,
  useActiveShikiTheme,
  SYNC_HIGHLIGHT_MAX_CHARS,
  type SyntaxToken,
} from "./shiki";

/**
 * Languages we support out of the box. The dropdown UI uses this list. The
 * `id` matches both the shiki grammar name (with aliases handled in
 * `./shiki.ts`) and (where applicable) the prettier parser key.
 */
export interface LanguageOption {
  id: string;
  label: string;
  /** Common file extensions that map to this language. */
  extensions: string[];
}

export const LANGUAGES: LanguageOption[] = [
  { id: "auto", label: "Auto-detect", extensions: [] },
  { id: "plaintext", label: "Plain text", extensions: ["txt"] },
  { id: "javascript", label: "JavaScript", extensions: ["js", "mjs", "cjs", "jsx"] },
  { id: "typescript", label: "TypeScript", extensions: ["ts", "tsx"] },
  { id: "python", label: "Python", extensions: ["py"] },
  { id: "rust", label: "Rust", extensions: ["rs"] },
  { id: "go", label: "Go", extensions: ["go"] },
  { id: "java", label: "Java", extensions: ["java"] },
  { id: "c", label: "C", extensions: ["c", "h"] },
  { id: "cpp", label: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh"] },
  { id: "csharp", label: "C#", extensions: ["cs"] },
  { id: "ruby", label: "Ruby", extensions: ["rb"] },
  { id: "php", label: "PHP", extensions: ["php"] },
  { id: "swift", label: "Swift", extensions: ["swift"] },
  { id: "kotlin", label: "Kotlin", extensions: ["kt", "kts"] },
  { id: "scala", label: "Scala", extensions: ["scala"] },
  { id: "shell", label: "Shell", extensions: ["sh", "bash", "zsh"] },
  { id: "html", label: "HTML", extensions: ["html", "htm"] },
  { id: "xml", label: "XML", extensions: ["xml", "svg"] },
  { id: "css", label: "CSS", extensions: ["css"] },
  { id: "scss", label: "SCSS", extensions: ["scss"] },
  { id: "json", label: "JSON", extensions: ["json"] },
  { id: "yaml", label: "YAML", extensions: ["yaml", "yml"] },
  { id: "markdown", label: "Markdown", extensions: ["md", "markdown"] },
  { id: "sql", label: "SQL", extensions: ["sql"] },
  { id: "graphql", label: "GraphQL", extensions: ["graphql", "gql"] },
];

/**
 * Shiki has no auto-detection. lowlight's `highlightAuto` (highlight.js
 * relevance scoring) is unreliable for web code — it frequently mis-IDs
 * TSX/JSX as PHP or XML. So we run our own heuristic scorer first and only
 * fall back to lowlight (with PHP and other rarely-correct guesses excluded)
 * when the heuristics are inconclusive.
 */
// Lazily created: `createLowlight(common)` registers ~35 highlight.js grammars,
// which is real startup work. It's only needed as a last-resort fallback in
// detectLanguage (most callers pass a known language or hit the heuristics
// first), so defer it until the first time auto-detection actually falls through.
let lowlightInstance: ReturnType<typeof createLowlight> | null = null;
function getLowlight(): ReturnType<typeof createLowlight> {
  if (!lowlightInstance) lowlightInstance = createLowlight(common);
  return lowlightInstance;
}

interface Signal {
  re: RegExp;
  weight: number;
}

/**
 * Per-language signature patterns. Weighted so that strongly distinctive
 * constructs (e.g. `interface X {`, `def f(`, `fn main`) outvote generic
 * ones shared across C-family languages.
 */
const SIGNALS: Record<string, Signal[]> = {
  typescript: [
    { re: /\binterface\s+\w+\s*(\extends\s+\w+\s*)?\{/g, weight: 3 },
    { re: /\btype\s+\w+\s*=/g, weight: 3 },
    { re: /:\s*(string|number|boolean|void|any|unknown|never|null)\b/g, weight: 2 },
    { re: /\b(import|export)\b[^\n]*\bfrom\s+['"]/g, weight: 2 },
    { re: /\bexport\s+(const|default|function|class|interface|type|async)\b/g, weight: 2 },
    { re: /\bas\s+(const|string|number|\w+\[\])/g, weight: 2 },
    { re: /\b(useState|useEffect|useCallback|useMemo|useRef)\s*[(<]/g, weight: 3 },
    { re: /<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*[\s/>]/g, weight: 2 }, // JSX
    { re: /=>\s*[({]/g, weight: 1 },
    { re: /\bconst\s+\w+\s*:\s*\w/g, weight: 2 },
  ],
  javascript: [
    { re: /\b(const|let|var)\s+\w+\s*=/g, weight: 1 },
    { re: /\bfunction\s*\*?\s*\w*\s*\(/g, weight: 2 },
    { re: /\b(require|module\.exports)\b/g, weight: 2 },
    { re: /\bconsole\.(log|warn|error)\b/g, weight: 1 },
    { re: /\b(import|export)\b[^\n]*\bfrom\s+['"]/g, weight: 1 },
    { re: /=>\s*[({]/g, weight: 1 },
  ],
  python: [
    { re: /\bdef\s+\w+\s*\(/g, weight: 3 },
    { re: /\bclass\s+\w+(\(|\s*:)/g, weight: 2 },
    { re: /^\s*(from\s+[\w.]+\s+)?import\s+\w/gm, weight: 2 },
    { re: /\bself\b/g, weight: 1 },
    { re: /\bprint\s*\(/g, weight: 1 },
    { re: /\bif\s+__name__\s*==/g, weight: 4 },
    { re: /:\s*$/gm, weight: 1 },
    { re: /\b(elif|None|True|False)\b/g, weight: 1 },
  ],
  go: [
    { re: /\bpackage\s+\w+/g, weight: 3 },
    { re: /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/g, weight: 3 },
    { re: /:=/g, weight: 2 },
    { re: /\bfmt\.\w+/g, weight: 2 },
    { re: /\bimport\s+\(/g, weight: 2 },
    { re: /\b(chan|defer|go|struct|interface)\b/g, weight: 1 },
  ],
  rust: [
    { re: /\bfn\s+\w+\s*[(<]/g, weight: 3 },
    { re: /\blet\s+mut\b/g, weight: 3 },
    { re: /\b(impl|pub\s+fn|pub\s+struct|trait)\b/g, weight: 2 },
    { re: /\buse\s+[\w:]+;/g, weight: 2 },
    { re: /\bprintln!|\bvec!|\bSome\(|\bOk\(|\bErr\(/g, weight: 2 },
    { re: /->\s*\w/g, weight: 1 },
  ],
  java: [
    { re: /\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|void|int|String)\b/g, weight: 3 },
    { re: /\bSystem\.out\.print/g, weight: 3 },
    { re: /\bimport\s+java[\w.]+;/g, weight: 3 },
    { re: /\b@Override\b/g, weight: 2 },
  ],
  ruby: [
    { re: /\bdef\s+\w/g, weight: 2 },
    { re: /^\s*end\s*$/gm, weight: 2 },
    { re: /\bputs\b|\brequire(_relative)?\b/g, weight: 2 },
    { re: /\b(do\s*\|[^|]*\||attr_accessor)\b/g, weight: 2 },
    { re: /@\w+/g, weight: 1 },
  ],
  css: [
    { re: /[.#]?[\w-]+\s*\{[^}]*\b[\w-]+\s*:\s*[^;{]+;/g, weight: 3 },
    { re: /@media\b|@keyframes\b/g, weight: 2 },
    { re: /\bvar\(--[\w-]+\)/g, weight: 2 },
  ],
  scss: [
    { re: /\$[\w-]+\s*:/g, weight: 3 },
    { re: /@(mixin|include|extend|use|function)\b/g, weight: 3 },
    { re: /&[:.\s]/g, weight: 1 },
  ],
  yaml: [
    { re: /^---\s*$/gm, weight: 2 },
    { re: /^\s*[\w-]+:\s+\S/gm, weight: 1 },
    { re: /^\s*-\s+\w/gm, weight: 1 },
  ],
  markdown: [
    { re: /^#{1,6}\s+\S/gm, weight: 3 },
    { re: /^\s*[-*+]\s+\S/gm, weight: 1 },
    { re: /```/g, weight: 2 },
    { re: /\[[^\]]+\]\([^)]+\)/g, weight: 2 },
  ],
  sql: [
    { re: /\bSELECT\b[\s\S]*\bFROM\b/gi, weight: 3 },
    { re: /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/gi, weight: 3 },
    { re: /\b(WHERE|JOIN|GROUP\s+BY|ORDER\s+BY)\b/gi, weight: 1 },
  ],
};

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Detect the language for a body of text. Returns a LANGUAGES id, or
 * "plaintext" if confidence is too low.
 */
export function detectLanguage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "plaintext";
  // Cap the work — the first chunk is plenty for detection.
  const sample = value.slice(0, 8000);

  // ── Unambiguous markers ────────────────────────────────────
  if (/<\?php\b/.test(sample)) return "php";
  if (/^#!.*\b(bash|sh|zsh|ksh)\b/m.test(sample)) return "shell";
  if (/^\s*<!DOCTYPE\s+html|<html[\s>]/i.test(sample)) return "html";

  // JSON: parses cleanly and starts like JSON.
  if (/^[\s\n]*[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* not valid JSON — keep going */
    }
  }

  // ── Heuristic scoring ──────────────────────────────────────
  let best = "";
  let bestScore = 0;
  for (const [lang, signals] of Object.entries(SIGNALS)) {
    if (signals.length === 0) continue;
    let score = 0;
    for (const { re, weight } of signals) {
      score += countMatches(sample, re) * weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }

  // JS vs TS tie-break: any TS-only signal forces typescript.
  if (best === "javascript") {
    const tsOnly =
      /\binterface\s+\w+\s*\{|\btype\s+\w+\s*=|:\s*(string|number|boolean)\b|\bas\s+const\b/;
    if (tsOnly.test(sample)) best = "typescript";
  }

  if (bestScore >= 3 && LANGUAGES.some((l) => l.id === best)) {
    return best;
  }

  // ── Fallback: lowlight, but exclude languages it tends to
  //    false-positive on (php/xml) so we don't repeat the bug. ─
  try {
    const lowlight = getLowlight();
    const known = new Set(lowlight.listLanguages());
    const subset = [
      "typescript",
      "javascript",
      "python",
      "go",
      "rust",
      "java",
      "ruby",
      "css",
      "scss",
      "json",
      "yaml",
      "markdown",
      "sql",
      "c",
      "cpp",
      "csharp",
      "kotlin",
      "swift",
      "scala",
      "bash",
    ].filter((l) => known.has(l));
    const tree = lowlight.highlightAuto(sample, { subset });
    const lang = tree.data?.language;
    if (lang === "bash") return "shell";
    if (lang && LANGUAGES.some((l) => l.id === lang)) return lang;
  } catch {
    /* ignore */
  }
  return "plaintext";
}

/** Best-effort language id from a file path / name. */
export function languageFromPath(path: string): string | null {
  const m = path.match(/\.([A-Za-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  for (const l of LANGUAGES) {
    if (l.extensions.includes(ext)) return l.id;
  }
  return null;
}
