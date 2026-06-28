import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@plan/shared/components/theme-provider";
import { FoldEngineProvider } from "@plan/shared/code-folding";
import App from "./App";
import { treeSitterFoldEngine } from "./code-folding";
import { THEMES } from "./lib/themes";
import "./globals.css";

// Desktop uses the tree-sitter fold engine ("preset"); the web app falls back to
// the default indentation engine. To remove the preset entirely: delete the
// ./code-folding folder and this provider wrap — folding reverts to indentation.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FoldEngineProvider engine={treeSitterFoldEngine}>
      <ThemeProvider themes={THEMES}>
        <App />
      </ThemeProvider>
    </FoldEngineProvider>
  </StrictMode>
);
