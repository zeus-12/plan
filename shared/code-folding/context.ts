import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import { indentationFoldEngine } from "./indentation";
import type { FoldEngine } from "./types";

// Default is the indentation engine, so with NO provider anywhere (e.g. the web
// app) folding still works. The desktop app wraps its tree once with a provider
// supplying the tree-sitter engine — that single wrap is the only reference to
// the "preset", so removing it reverts the whole app to indentation folding.
const FoldEngineContext = createContext<FoldEngine>(indentationFoldEngine);

export function FoldEngineProvider({
  engine,
  children,
}: {
  engine: FoldEngine;
  children: ReactNode;
}) {
  return createElement(FoldEngineContext.Provider, { value: engine }, children);
}

export function useFoldEngine(): FoldEngine {
  return useContext(FoldEngineContext);
}
