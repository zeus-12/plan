import LZString from "lz-string";

/**
 * Shared envelope for state shipped in a URL fragment: JSON → LZString,
 * versioned so links from an older wire format fail closed (decode returns
 * null) instead of half-parsing. Callers own the mapping between their domain
 * shape and the short-keyed wire fields, and validate fields on decode.
 */
export function encodeVersioned(version: number, fields: object): string {
  return LZString.compressToEncodedURIComponent(
    JSON.stringify({ v: version, ...fields }),
  );
}

/**
 * Reverse of encodeVersioned. Returns the raw wire object for the caller to
 * validate field-by-field, or null when the input is empty, malformed, or a
 * different version.
 */
export function decodeVersioned(
  version: number,
  encoded: string,
): Record<string, unknown> | null {
  if (!encoded) return null;
  try {
    const raw = LZString.decompressFromEncodedURIComponent(encoded);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.v !== version) return null;
    return parsed;
  } catch {
    return null;
  }
}
