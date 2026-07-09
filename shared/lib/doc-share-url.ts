import { FRONTEND_URL } from "./config";
import { encodeVersioned, decodeVersioned } from "./url-codec";

/** The `/doc` route's hash prefix — shared by the web page and link builders. */
export const DOC_HASH_PREFIX = "#c=";

/**
 * A single comment anchored to a character range in the document. The doc text
 * is read-only once shared, so `start`/`end` never drift — the offsets are a
 * stable anchor. `quote` is a snapshot of the selected text (for display and to
 * defensively detect a mismatch if the anchor is ever wrong).
 */
export interface DocComment {
  id: string;
  start: number;
  end: number;
  quote: string;
  body: string;
  /** Self-claimed display name of the commenter (no real identity/auth). */
  author?: string;
  /**
   * Random UUID identifying the browser the comment was written in (stored in
   * localStorage). Lets a later name change re-attribute that device's earlier
   * comments — it is not an identity, just "same browser as".
   */
  deviceId?: string;
  /** Epoch ms when the comment was created. */
  createdAt?: number;
}

export interface DocState {
  text: string;
  language?: string;
  comments: DocComment[];
}

const VERSION = 1;

/** Serialized comment — short keys keep the URL compact. */
interface WireComment {
  i: string;
  s: number;
  e: number;
  q: string;
  b: string;
  a?: string;
  d?: string;
  t?: number;
}

/** Convert doc state to a URL-safe compressed string. */
export function encodeDocState(state: DocState): string {
  return encodeVersioned(VERSION, {
    t: state.text,
    lang: state.language,
    c: state.comments.map(
      (c): WireComment => ({
        i: c.id,
        s: c.start,
        e: c.end,
        q: c.quote,
        b: c.body,
        a: c.author,
        d: c.deviceId,
        t: c.createdAt,
      }),
    ),
  });
}

/**
 * Build a full, shareable `/doc` URL for the given state. Used by the desktop
 * app to open a file's contents in the web doc tool.
 */
export function buildDocUrl(
  state: DocState,
  base: string = FRONTEND_URL,
): string {
  return `${base.replace(/\/+$/, "")}/doc${DOC_HASH_PREFIX}${encodeDocState(state)}`;
}

/** Reverse of encodeDocState. Returns null if the input is malformed. */
export function decodeDocState(encoded: string): DocState | null {
  const parsed = decodeVersioned(VERSION, encoded);
  if (!parsed) return null;
  if (typeof parsed.t !== "string") return null;
  const comments: DocComment[] = Array.isArray(parsed.c)
    ? parsed.c.flatMap((raw) => {
        const c = raw as Partial<WireComment>;
        if (
          typeof c.i !== "string" ||
          typeof c.s !== "number" ||
          typeof c.e !== "number" ||
          typeof c.b !== "string"
        ) {
          return [];
        }
        return [
          {
            id: c.i,
            start: c.s,
            end: c.e,
            quote: typeof c.q === "string" ? c.q : "",
            body: c.b,
            author: typeof c.a === "string" ? c.a : undefined,
            deviceId: typeof c.d === "string" ? c.d : undefined,
            createdAt: typeof c.t === "number" ? c.t : undefined,
          },
        ];
      })
    : [];
  return {
    text: parsed.t,
    language: typeof parsed.lang === "string" ? parsed.lang : undefined,
    comments,
  };
}
