import { formatCode, type FormatResult } from "@plan/shared/lib/format";

/**
 * Format via a Web Worker so prettier's (heavy, synchronous) parse never blocks
 * the main thread. Degrades gracefully: if workers are unavailable or the worker
 * fails to spin up, it falls back to formatting inline — same result, just on the
 * main thread. A single worker is reused across calls; requests are correlated by
 * id so overlapping formats can't cross their results.
 */
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, (r: FormatResult) => void>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (typeof window === "undefined" || typeof Worker === "undefined")
    return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./format-worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<{ id: number; result: FormatResult }>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data.result);
      }
    };
    w.onerror = () => {
      // Something went wrong in the worker — stop using it and let callers fall
      // back to the main thread (pending promises settle via that path below).
      workerBroken = true;
      worker = null;
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

export function formatCodeAsync(
  source: string,
  language: string,
): Promise<FormatResult> {
  const w = getWorker();
  if (!w) return formatCode(source, language);
  return new Promise<FormatResult>((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    try {
      w.postMessage({ id, source, language });
    } catch {
      pending.delete(id);
      resolve(formatCode(source, language));
    }
  });
}
