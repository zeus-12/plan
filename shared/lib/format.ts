import type { Options, Plugin } from "prettier";

/**
 * Map our LANGUAGES ids to a prettier parser + plugins. Plugins are imported
 * lazily so we don't ship every parser into the initial bundle.
 */
interface ParserConfig {
  parser: string;
  /** Plugin loaders — invoked the first time we format this language. */
  load: () => Promise<Plugin[]>;
}

const CONFIGS: Record<string, ParserConfig> = {
  javascript: {
    parser: "babel",
    load: async () => [
      (await import("prettier/plugins/babel")).default,
      (await import("prettier/plugins/estree")).default,
    ],
  },
  typescript: {
    parser: "typescript",
    load: async () => [
      (await import("prettier/plugins/typescript")).default,
      (await import("prettier/plugins/estree")).default,
    ],
  },
  json: {
    parser: "json",
    load: async () => [
      (await import("prettier/plugins/babel")).default,
      (await import("prettier/plugins/estree")).default,
    ],
  },
  css: {
    parser: "css",
    load: async () => [(await import("prettier/plugins/postcss")).default],
  },
  scss: {
    parser: "scss",
    load: async () => [(await import("prettier/plugins/postcss")).default],
  },
  html: {
    parser: "html",
    load: async () => [(await import("prettier/plugins/html")).default],
  },
  xml: {
    parser: "html",
    load: async () => [(await import("prettier/plugins/html")).default],
  },
  markdown: {
    parser: "markdown",
    load: async () => [(await import("prettier/plugins/markdown")).default],
  },
  yaml: {
    parser: "yaml",
    load: async () => [(await import("prettier/plugins/yaml")).default],
  },
  graphql: {
    parser: "graphql",
    load: async () => [(await import("prettier/plugins/graphql")).default],
  },
};

export function canFormat(languageId: string): boolean {
  return languageId in CONFIGS;
}

export interface FormatResult {
  ok: boolean;
  value: string;
  error?: string;
}

const pluginCache = new Map<string, Plugin[]>();

export async function formatCode(
  source: string,
  languageId: string,
  overrides?: Partial<Options>
): Promise<FormatResult> {
  const config = CONFIGS[languageId];
  if (!config) {
    return { ok: false, value: source, error: `No formatter for ${languageId}` };
  }

  try {
    let plugins = pluginCache.get(languageId);
    if (!plugins) {
      plugins = await config.load();
      pluginCache.set(languageId, plugins);
    }

    const { format } = await import("prettier/standalone");
    const out = await format(source, {
      parser: config.parser,
      plugins,
      ...overrides,
    });
    return { ok: true, value: out };
  } catch (err) {
    return {
      ok: false,
      value: source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
