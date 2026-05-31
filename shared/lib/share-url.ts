import LZString from "lz-string";

export interface SharedState {
  left: string;
  right: string;
  language?: string;
}

const VERSION = 1;

/** Convert state to a URL-safe compressed string. */
export function encodeState(state: SharedState): string {
  const payload = JSON.stringify({
    v: VERSION,
    l: state.left,
    r: state.right,
    lang: state.language,
  });
  return LZString.compressToEncodedURIComponent(payload);
}

/** Reverse of encodeState. Returns null if the input is malformed. */
export function decodeState(encoded: string): SharedState | null {
  if (!encoded) return null;
  try {
    const raw = LZString.decompressFromEncodedURIComponent(encoded);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      v?: number;
      l?: unknown;
      r?: unknown;
      lang?: unknown;
    };
    if (parsed.v !== VERSION) return null;
    return {
      left: typeof parsed.l === "string" ? parsed.l : "",
      right: typeof parsed.r === "string" ? parsed.r : "",
      language: typeof parsed.lang === "string" ? parsed.lang : undefined,
    };
  } catch {
    return null;
  }
}
