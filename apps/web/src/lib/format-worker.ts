/// <reference lib="webworker" />
// Runs prettier off the main thread. Formatting a large document parses the
// whole AST — hundreds of ms to seconds — which froze the UI when done inline.
// The worker keeps the page (editors, scrolling, the diff) responsive while it
// works. `formatCode` lazily imports prettier + the parser plugins here, so they
// load in the worker rather than the main bundle.
import { formatCode, type FormatResult } from "@plan/shared/lib/format";

interface FormatRequest {
  id: number;
  source: string;
  language: string;
}

self.onmessage = async (e: MessageEvent<FormatRequest>) => {
  const { id, source, language } = e.data;
  let result: FormatResult;
  try {
    result = await formatCode(source, language);
  } catch (err) {
    result = {
      ok: false,
      value: source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  (self as unknown as Worker).postMessage({ id, result });
};
