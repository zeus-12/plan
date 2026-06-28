import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Language, Parser, Query, type QueryCapture } from "web-tree-sitter";
import { foldRangesFromCaptures } from "../src/renderer/code-folding/extract";
import { FOLD_REGISTRY } from "../src/renderer/code-folding/registry";

// Vendored assets live next to the engine source.
const dir = new URL("../src/renderer/code-folding/", import.meta.url).pathname;

beforeAll(async () => {
  await Parser.init({ locateFile: () => `${dir}tree-sitter.wasm` });
});

async function folds(languageId: string, code: string) {
  const entry = FOLD_REGISTRY[languageId];
  if (!entry) throw new Error(`no registry entry for ${languageId}`);
  const language = await Language.load(`${dir}grammars/${entry.grammar}.wasm`);
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(
    language,
    readFileSync(`${dir}queries/${entry.query}.scm`, "utf8")
  );
  const tree = parser.parse(code);
  if (!tree) throw new Error("parse failed");
  return foldRangesFromCaptures(query.captures(tree.rootNode) as QueryCapture[]);
}

describe("tree-sitter fold extraction", () => {
  it("typescript: folds a function body, keeps the closing brace visible", async () => {
    const code = ["function f() {", "  const a = 1;", "  return a;", "}"].join(
      "\n"
    );
    // start=0 (function line), end=2 (last body line) → line 3 `}` stays visible.
    expect(await folds("typescript", code)).toContainEqual({ start: 0, end: 2 });
  });

  it("tsx: folds a JSX element", async () => {
    const code = [
      "const x = (",
      "  <div>",
      "    <span>hi</span>",
      "  </div>",
      ");",
    ].join("\n");
    expect((await folds("tsx", code)).some((x) => x.start === 1)).toBe(true);
  });

  it("python: folds a def block (indentation-structured grammar)", async () => {
    const code = ["def f():", "    x = 1", "    return x", ""].join("\n");
    expect((await folds("python", code)).some((x) => x.start === 0)).toBe(true);
  });

  it("json: folds an object", async () => {
    const code = ["{", '  "a": 1,', '  "b": 2', "}"].join("\n");
    expect(await folds("json", code)).toContainEqual({ start: 0, end: 2 });
  });

  it("does not fold single-line constructs", async () => {
    expect(await folds("json", '{ "a": 1 }')).toEqual([]);
  });
});
