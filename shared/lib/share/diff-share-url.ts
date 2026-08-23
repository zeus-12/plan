import { FRONTEND_URL } from "./config";
import { decodeVersioned, encodeVersioned } from "./url-codec";

/** The diff page's hash prefix — shared by the web page and link builders. */
export const DIFF_HASH_PREFIX = "#d=";

export interface SharedDiffState {
  left: string;
  right: string;
  language?: string;
}

const VERSION = 1;

/** Convert diff state to a URL-safe compressed string. */
export function encodeDiffState(state: SharedDiffState): string {
  return encodeVersioned(VERSION, {
    l: state.left,
    r: state.right,
    lang: state.language,
  });
}

/** Build a full URL that opens the web diff with both versions populated. */
export function buildDiffUrl(
  state: SharedDiffState,
  base: string = FRONTEND_URL,
): string {
  return `${base.replace(/\/+$/, "")}/${DIFF_HASH_PREFIX}${encodeDiffState(state)}`;
}

/** Reverse of encodeDiffState. Returns null if the input is malformed. */
export function decodeDiffState(encoded: string): SharedDiffState | null {
  const parsed = decodeVersioned(VERSION, encoded);
  if (!parsed) return null;
  return {
    left: typeof parsed.l === "string" ? parsed.l : "",
    right: typeof parsed.r === "string" ? parsed.r : "",
    language: typeof parsed.lang === "string" ? parsed.lang : undefined,
  };
}
