import { cn } from "@plan/shared/lib/utils";

/**
 * File + folder icons using the actual SVG assets from VSCode's Material Icon
 * Theme (material-extensions/vscode-material-icon-theme), bundled locally under
 * ./assets/file-icons — no runtime dependency. Vite inlines each SVG as a URL.
 *
 * The theme generates open-folder icons at runtime (no static asset), so we use
 * the base folder for both states; the tree's chevron conveys open/closed.
 */
const modules = import.meta.glob("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const ICON_URL: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  const base = path
    .split("/")
    .pop()
    ?.replace(/\.svg$/, "");
  if (base) ICON_URL[base] = url;
}

/** Extension → Material icon asset name. */
const BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "react",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "document",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "h",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "hpp",
  cs: "csharp",
  php: "php",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  ini: "settings",
  cfg: "settings",
  conf: "settings",
  config: "settings",
  sql: "database",
  lock: "lock",
  env: "tune",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "svg",
  pdf: "pdf",
};

/** Exact filename → Material icon asset name (wins over extension). */
const BY_NAME: Record<string, string> = {
  "package.json": "nodejs",
  "package-lock.json": "nodejs",
  "tsconfig.json": "tsconfig",
  dockerfile: "docker",
  ".dockerignore": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
};

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1);
}

function iconName(filename: string): string {
  const lower = filename.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith("readme")) return "readme";
  if (lower.startsWith(".env")) return "tune";
  if (lower.startsWith("tsconfig") && lower.endsWith(".json"))
    return "tsconfig";
  if (lower.startsWith("license") || lower.startsWith("licence"))
    return "certificate";
  return BY_EXT[ext(lower)] ?? "document";
}

export function FileIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const url = ICON_URL[iconName(name)] ?? ICON_URL.document;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className={cn("h-[15px] w-[15px] shrink-0 select-none", className)}
    />
  );
}

export function FolderIcon({
  open: _open,
  className,
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <img
      src={ICON_URL["folder-base"]}
      alt=""
      draggable={false}
      className={cn("h-[15px] w-[15px] shrink-0 select-none", className)}
    />
  );
}
