import { languageFromPath } from "@plan/shared/lib/syntax/highlight";
import type { SentFile } from "@/common/shared-types";
import type { ToolPreview } from "./tool-preview-card";

/**
 * SendUserFile, from the transcript's input JSON to what its hover card shows.
 *
 * Everything here is pure: main does the bounded read (see main/fs/sent-file.ts)
 * and this decides how much of what came back is worth rendering. Both caps
 * matter — the byte cap bounds the I/O, the row cap bounds the work of drawing
 * it, and 256 KB of a narrow CSV is thousands of rows either way.
 */

const MAX_PREVIEW_ROWS = 200;

export interface SentFileCall {
  /** Absolute paths, as the tool was called with them. */
  files: string[];
  caption: string;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseSendUserFile(input: unknown): SentFileCall | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const raw = Array.isArray(obj.files) ? obj.files : [];
  const files = raw.filter((f): f is string => typeof f === "string" && !!f);
  if (!files.length) return null;
  return { files, caption: asStr(obj.caption).trim() };
}

/**
 * RFC 4180 fields: commas and newlines survive inside quotes, and `""` is a
 * literal quote. Stops at `maxRows` rows, so the parse costs what the card
 * shows rather than what the read returned.
 */
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Base-10 units, the way Finder reports a file's size. */
export function formatBytes(size: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let n = size;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  if (unit === 0) return `${size} ${units[0]}`;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/**
 * `<count> rows · 84 KB`, or `first <count> rows · 412 MB` when what we hold is
 * a head. The total is never stated for a partial read — nothing counted it.
 */
function meta(
  shown: number,
  noun: string,
  whole: boolean,
  size: number,
): string {
  const count = `${shown} ${shown === 1 ? noun : `${noun}s`}`;
  return `${whole ? count : `first ${count}`} · ${formatBytes(size)}`;
}

function isCsv(path: string): boolean {
  return path.toLowerCase().endsWith(".csv");
}

/**
 * The hover card for a sent file, or null when there is nothing honest to show
 * (a binary, or a file that couldn't be read). The row still carries the name,
 * the caption and the Open control in that case.
 */
export function sentFilePreview(
  path: string,
  file: SentFile,
): ToolPreview | null {
  if (file.kind === "image") {
    return {
      kind: "image",
      path,
      srcs: [file.url],
      meta: formatBytes(file.size),
    };
  }
  if (file.kind !== "text" || !file.text) return null;

  if (isCsv(path)) {
    const parsed = parseCsv(file.text, MAX_PREVIEW_ROWS + 1);
    const [columns, ...body] = parsed;
    if (!columns?.length) return null;
    // A head cut mid-record leaves a short final row; it is an artefact of the
    // cut, not data, so it doesn't get rendered as if it were a row.
    if (
      !file.complete &&
      body.length &&
      body[body.length - 1].length !== columns.length
    ) {
      body.pop();
    }
    const whole = file.complete && parsed.length <= MAX_PREVIEW_ROWS + 1;
    return {
      kind: "table",
      path,
      columns,
      rows: body,
      meta: meta(body.length, "row", whole, file.size),
    };
  }

  const lines = file.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown = lines.slice(0, MAX_PREVIEW_ROWS);
  const whole = file.complete && lines.length === shown.length;
  return {
    kind: "text",
    path,
    language: languageFromPath(path) || "plaintext",
    text: shown.join("\n"),
    meta: meta(shown.length, "line", whole, file.size),
  };
}
