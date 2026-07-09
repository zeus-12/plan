import { encodeVersioned, decodeVersioned } from "./url-codec";

export interface SharedState {
  left: string;
  right: string;
  language?: string;
}

const VERSION = 1;

/** Convert state to a URL-safe compressed string. */
export function encodeState(state: SharedState): string {
  return encodeVersioned(VERSION, {
    l: state.left,
    r: state.right,
    lang: state.language,
  });
}

/** Reverse of encodeState. Returns null if the input is malformed. */
export function decodeState(encoded: string): SharedState | null {
  const parsed = decodeVersioned(VERSION, encoded);
  if (!parsed) return null;
  return {
    left: typeof parsed.l === "string" ? parsed.l : "",
    right: typeof parsed.r === "string" ? parsed.r : "",
    language: typeof parsed.lang === "string" ? parsed.lang : undefined,
  };
}
