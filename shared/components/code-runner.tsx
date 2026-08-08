import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * Runs a shell snippet in a brand-new terminal for whatever project (or
 * worktree) the surrounding UI belongs to.
 *
 * Markdown renders in surfaces that have no ptys behind them (the web build,
 * any preview), so the runner is injected rather than imported: no provider
 * means no run button, instead of a button that can't do anything.
 */
export type CodeRunner = (command: string) => void;

const CodeRunnerContext = createContext<CodeRunner | null>(null);

export function CodeRunnerProvider({
  run,
  children,
}: {
  run: CodeRunner;
  children: ReactNode;
}) {
  return (
    <CodeRunnerContext.Provider value={run}>
      {children}
    </CodeRunnerContext.Provider>
  );
}

export function useCodeRunner(): CodeRunner | null {
  return useContext(CodeRunnerContext);
}
