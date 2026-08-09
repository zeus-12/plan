/**
 * Reconstructing a file's text at a point in the session, from the transcript
 * plus the file on disk.
 *
 * The transcript records each write as a fragment pair (`old_string` →
 * `new_string`) with no position, so a turn's pills can show WHAT changed but
 * not WHERE. Real line numbers need the file's full text before and after the
 * turn, and there are exactly two ways to get it:
 *
 *   - Forward from a checkpoint. A Write records the file's entire content, so
 *     any point at or after a Write is reachable by replaying the Edits that
 *     follow it. This is exact — replay does what the Edit tool does.
 *   - Backward from disk. With no checkpoint, start at the file as it is now
 *     and peel later edits off in reverse (`new_string` → `old_string`).
 *
 * Peeling is the fallible half, and it fails loudly rather than guessing: if a
 * fragment is missing (someone edited the file outside this session) or appears
 * more than once (nothing says which instance this edit produced), the walk
 * returns null and the caller shows the fragment view instead of a line number
 * that might be a lie.
 *
 * What this CANNOT detect: another writer changing a part of the file none of
 * our edits touch. Peeling still succeeds, the diff body is still right, but
 * every line number shifts by whatever they inserted above.
 */

import type { ConversationMessage } from "@/common/shared-types";
import { isPlanFilePath } from "./plan-card";

export interface FileEditOp {
  kind: "edit";
  /** Row (message index) this op came from — how ops map back to turns. */
  row: number;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

export interface FileWriteOp {
  kind: "write";
  row: number;
  content: string;
}

export type FileOp = FileEditOp | FileWriteOp;

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** The ops one tool call performs, or null when it doesn't write a file. */
export function opsFromToolUse(
  tool: string,
  input: unknown,
  row: number,
): { path: string; ops: FileOp[] } | null {
  const o = obj(input);
  if (!o) return null;
  const path = asStr(o.file_path);
  if (!path || isPlanFilePath(path)) return null;

  switch (tool) {
    case "Write": {
      const content = asStr(o.content);
      if (!content) return null;
      return { path, ops: [{ kind: "write", row, content }] };
    }
    case "Edit": {
      const oldText = asStr(o.old_string);
      const newText = asStr(o.new_string);
      if (!oldText && !newText) return null;
      return {
        path,
        ops: [
          {
            kind: "edit",
            row,
            oldText,
            newText,
            replaceAll: o.replace_all === true,
          },
        ],
      };
    }
    case "MultiEdit": {
      const raw = Array.isArray(o.edits) ? o.edits : [];
      const ops = raw
        .map(obj)
        .filter((e): e is Record<string, unknown> => e != null)
        .map(
          (e): FileEditOp => ({
            kind: "edit",
            row,
            oldText: asStr(e.old_string),
            newText: asStr(e.new_string),
            replaceAll: e.replace_all === true,
          }),
        )
        .filter((e) => e.oldText || e.newText);
      return ops.length ? { path, ops } : null;
    }
    default:
      return null;
  }
}

/** Every write in the transcript, per file, in the order they happened. */
export function buildFileOps(
  items: ConversationMessage[],
): Map<string, FileOp[]> {
  const byPath = new Map<string, FileOp[]>();
  items.forEach((m, row) => {
    for (const p of m.parts) {
      if (p.kind !== "tool_use") continue;
      const found = opsFromToolUse(p.tool, p.input, row);
      if (!found) continue;
      const list = byPath.get(found.path);
      if (list) list.push(...found.ops);
      else byPath.set(found.path, [...found.ops]);
    }
  });
  return byPath;
}

/** Apply an op the way the tool itself did. Null when its target is missing. */
export function applyForward(text: string, op: FileOp): string | null {
  if (op.kind === "write") return op.content;
  if (!op.oldText) return null;
  if (op.replaceAll) {
    return text.includes(op.oldText)
      ? text.split(op.oldText).join(op.newText)
      : null;
  }
  const at = text.indexOf(op.oldText);
  if (at === -1) return null;
  return text.slice(0, at) + op.newText + text.slice(at + op.oldText.length);
}

/**
 * Undo an op. Null when the result can't be trusted: a Write erased whatever
 * came before it, the fragment is gone, or it appears more than once and
 * nothing identifies which instance this op produced.
 */
export function applyReverse(text: string, op: FileOp): string | null {
  if (op.kind === "write") return null;
  if (!op.newText) return null;
  if (op.replaceAll) {
    return text.includes(op.newText)
      ? text.split(op.newText).join(op.oldText)
      : null;
  }
  const at = text.indexOf(op.newText);
  if (at === -1) return null;
  if (text.indexOf(op.newText, at + 1) !== -1) return null;
  return text.slice(0, at) + op.oldText + text.slice(at + op.newText.length);
}

/**
 * The file's text right after `index` (an index into `ops`; -1 means before any
 * of them), or null when it can't be reconstructed exactly.
 */
export function textAfterOp(
  ops: FileOp[],
  index: number,
  diskText: string,
): string | null {
  let checkpoint = -1;
  for (let i = index; i >= 0; i--) {
    if (ops[i].kind === "write") {
      checkpoint = i;
      break;
    }
  }

  if (checkpoint >= 0) {
    let text = (ops[checkpoint] as FileWriteOp).content;
    for (let i = checkpoint + 1; i <= index; i++) {
      const next = applyForward(text, ops[i]);
      if (next === null) return null;
      text = next;
    }
    return text;
  }

  let text = diskText;
  for (let i = ops.length - 1; i > index; i--) {
    const prev = applyReverse(text, ops[i]);
    if (prev === null) return null;
    text = prev;
  }
  return text;
}
