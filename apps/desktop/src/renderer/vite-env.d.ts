// Vite is only a transitive dependency here (no hoisted `node_modules/vite`),
// so `/// <reference types="vite/client" />` can't resolve. Declare the one
// Vite-injected API we use — `import.meta.glob` for bundling the icon assets.
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string }
  ): Record<string, unknown>;
}

// Vite asset imports with explicit query suffixes resolve to a URL / raw text.
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?raw" {
  const source: string;
  export default source;
}
