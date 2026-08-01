import type { Plugin } from "prettier";

/**
 * The languages the scratchpad offers. `id` doubles as the Shiki language id
 * (the shared highlighter's `resolveLang` understands all of these), so the
 * highlighted layer needs no separate mapping. `prettierParser` names the
 * Prettier parser used by ⌘S — omitted where Prettier has no formatter (plain
 * text, Python, XML), which is why `formattable` is derived from it.
 */
export interface ScratchLanguage {
  id: string;
  label: string;
  prettierParser?: string;
}

export const LANGUAGES: readonly (ScratchLanguage & {
  formattable: boolean;
})[] = (
  [
    { id: "plaintext", label: "Plain Text" },
    { id: "json", label: "JSON", prettierParser: "json" },
    { id: "javascript", label: "JavaScript", prettierParser: "babel" },
    { id: "typescript", label: "TypeScript", prettierParser: "typescript" },
    { id: "jsx", label: "JSX", prettierParser: "babel" },
    { id: "tsx", label: "TSX", prettierParser: "typescript" },
    { id: "markdown", label: "Markdown", prettierParser: "markdown" },
    { id: "css", label: "CSS", prettierParser: "css" },
    { id: "html", label: "HTML", prettierParser: "html" },
    { id: "python", label: "Python" },
    { id: "yaml", label: "YAML", prettierParser: "yaml" },
    { id: "xml", label: "XML" },
  ] as const
).map((l) => ({
  ...l,
  formattable: "prettierParser" in l && !!l.prettierParser,
}));

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

/**
 * True only when `text` is unambiguously a JSON object or array. We require the
 * `{`/`[` lead + a successful parse so a bare `true`/`42`/word isn't mistaken
 * for JSON — the one language we can detect with certainty rather than a guess.
 */
export function detectJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

type PrettifyResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Format `src` with Prettier for the given language. Parser plugins are loaded
 * lazily (only when the user actually formats) to keep the initial load light.
 * Returns a typed error on unsupported languages or parse failures so the caller
 * can surface exactly why nothing changed.
 */
export async function prettify(
  src: string,
  languageId: string,
): Promise<PrettifyResult> {
  const lang = BY_ID.get(languageId);
  const parser = lang?.prettierParser;
  if (!parser) {
    return {
      ok: false,
      error: `No formatter for ${lang?.label ?? languageId}`,
    };
  }
  try {
    const [{ format }, plugins] = await Promise.all([
      import("prettier/standalone"),
      loadPrettierPlugins(parser),
    ]);
    const text = await format(src, { parser, plugins, tabWidth: 2 });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadPrettierPlugins(parser: string): Promise<Plugin[]> {
  switch (parser) {
    case "json":
    case "babel": {
      const [babel, estree] = await Promise.all([
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
      ]);
      return [babel.default, estree.default];
    }
    case "typescript": {
      const [ts, estree] = await Promise.all([
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
      return [ts.default, estree.default];
    }
    case "css":
      return [(await import("prettier/plugins/postcss")).default];
    case "html":
      return [(await import("prettier/plugins/html")).default];
    case "markdown":
      return [(await import("prettier/plugins/markdown")).default];
    case "yaml":
      return [(await import("prettier/plugins/yaml")).default];
    default:
      return [];
  }
}
