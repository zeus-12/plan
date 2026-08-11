import { open, stat } from "fs/promises";
import { StringDecoder } from "string_decoder";
import { pathToFileURL } from "url";
import { extOf, looksBinary } from "./fs-util";
import type { SentFile } from "@/common/shared-types";

/**
 * The read behind a sent file's hover preview.
 *
 * A sent file is whatever the agent handed over — routinely a scratchpad CSV,
 * occasionally something enormous. The read is therefore bounded at the syscall
 * rather than after the fact: one positioned read of the first {@link HEAD_BYTES},
 * so a 300 GB file costs exactly what a 300 KB one does. (`readProjectFile`
 * takes the other approach — whole file into memory, then sliced — which is why
 * this doesn't reuse it.)
 *
 * Coming back short of the cap means EOF, so the caller knows it holds the
 * entire file and may count its rows. Otherwise it holds a head, and says so.
 */

const HEAD_BYTES = 256 * 1024;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
]);

/** Drop the trailing partial line, so a byte-cut head never shows half a row. */
function cutAtLastNewline(text: string): string {
  const last = text.lastIndexOf("\n");
  return last === -1 ? text : text.slice(0, last + 1);
}

export async function readSentFile(path: string): Promise<SentFile | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null; // gone, or unreadable — the caller shows no preview at all.
  }
  if (!info.isFile()) return null;

  const base = { size: info.size, mtimeMs: info.mtimeMs, url: "", text: "" };

  // An image is already a file on disk; handing back its URL keeps its bytes
  // out of IPC entirely (the same trick the transcript's images use).
  if (IMAGE_EXTS.has(extOf(path))) {
    return {
      ...base,
      kind: "image",
      url: pathToFileURL(path).href,
      complete: true,
    };
  }

  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead);
    if (looksBinary(head)) return { ...base, kind: "binary", complete: false };

    // Short of the cap means we hit EOF. The size check covers the exact-fit
    // case, where a full buffer really is the whole file.
    const complete = bytesRead < HEAD_BYTES || bytesRead >= info.size;
    const decoder = new StringDecoder("utf8");
    // A byte cut lands mid-character as easily as mid-line; the decoder holds
    // the incomplete sequence back rather than emitting U+FFFD for it, and the
    // line cut then discards it along with the partial row.
    const decoded = decoder.write(head);
    const text = complete ? decoded + decoder.end() : cutAtLastNewline(decoded);
    return { ...base, kind: "text", text, complete };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
