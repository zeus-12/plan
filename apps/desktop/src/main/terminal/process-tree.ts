import { execFile } from "child_process";

/**
 * The real OS process tree — one `ps` snapshot, shared by everything in main
 * that needs to see past a pty's shell (which agent is running under it, what
 * a kill has to take down with it). Pure OS introspection, keyed by pid;
 * nothing here knows about ptys or sessions.
 */

export interface ProcEntry {
  pid: number;
  comm: string;
}
/** Child entries keyed by parent pid. */
export type ProcTree = Map<number, ProcEntry[]>;

// `ps -ax` lists EVERY process on the system and is the expensive part of a
// status check (100–500ms on a busy Mac). The output is identical for every
// caller at a given moment, yet each one asks independently. So we snapshot the
// whole tree once and share it for a short window: concurrent and back-to-back
// probes collapse onto one `ps` run instead of spawning one each. The per-pid
// BFS is then in-memory.
const PS_TTL_MS = 2_000;
let cache: { at: number; tree: ProcTree } | null = null;
let inflight: Promise<ProcTree> | null = null;

/**
 * The process tree, cached for a couple of seconds. `fresh` forces a new `ps` —
 * for a kill sweep, where a child spawned since the last snapshot is exactly
 * what we must not miss.
 */
export function getProcessTree(fresh = false): Promise<ProcTree> {
  if (!fresh && cache && Date.now() - cache.at < PS_TTL_MS) {
    return Promise.resolve(cache.tree);
  }
  if (inflight) return inflight;
  inflight = new Promise<ProcTree>((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid=,comm="], (err, stdout) => {
      inflight = null;
      if (err) {
        reject(err);
        return;
      }
      const childrenOf: ProcTree = new Map();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const entry = { pid: Number(m[1]), comm: m[3] };
        const ppid = Number(m[2]);
        const arr = childrenOf.get(ppid);
        if (arr) arr.push(entry);
        else childrenOf.set(ppid, [entry]);
      }
      cache = { at: Date.now(), tree: childrenOf };
      resolve(childrenOf);
    });
  });
  return inflight;
}

/**
 * Every descendant pid of `rootPid`, deepest-last. Throws when `ps` fails — the
 * caller decides its fallback.
 */
export async function descendantPids(
  rootPid: number,
  fresh = false,
): Promise<number[]> {
  const childrenOf = await getProcessTree(fresh);
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const c of childrenOf.get(pid) ?? []) {
      out.push(c.pid);
      queue.push(c.pid);
    }
  }
  return out;
}
