import { execFile } from "child_process";

/**
 * Agent-process probing: walk the real process tree (`ps`) to find the agent
 * (claude / its node host) among a pty shell's descendants — node-pty's
 * foreground-process name is unreliable on macOS. Pure OS introspection, keyed
 * by pid; nothing here knows about ptys or sessions.
 */

// `ps -ax` lists EVERY process on the system and is the expensive part of a
// status check (100–500ms on a busy Mac). The output is identical for every
// terminal at a given moment, yet each open session polls status independently
// (1–5s each). So we snapshot the whole process tree once and share it for a
// short window: concurrent and back-to-back polls collapse onto one `ps` run
// instead of spawning one each. The per-pid BFS below is then in-memory.
type ProcTree = Map<number, { pid: number; comm: string }[]>;
const PS_TTL_MS = 2_000;
let procTreeCache: { at: number; tree: ProcTree } | null = null;
let procTreeInflight: Promise<ProcTree> | null = null;

function getProcessTree(): Promise<ProcTree> {
  const now = Date.now();
  if (procTreeCache && now - procTreeCache.at < PS_TTL_MS) {
    return Promise.resolve(procTreeCache.tree);
  }
  if (procTreeInflight) return procTreeInflight;
  procTreeInflight = new Promise<ProcTree>((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid=,comm="], (err, stdout) => {
      procTreeInflight = null;
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
      procTreeCache = { at: Date.now(), tree: childrenOf };
      resolve(childrenOf);
    });
  });
  return procTreeInflight;
}

/**
 * Name of the agent process (claude / node) among `rootPid`'s descendants, or
 * null when none is running. Throws when `ps` itself fails — the caller
 * decides its fallback.
 */
export async function agentProcessFor(rootPid: number): Promise<string | null> {
  const childrenOf = await getProcessTree();
  // BFS from the shell pid for an agent process among its descendants.
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const c of childrenOf.get(pid) ?? []) {
      const base = (c.comm.split("/").pop() ?? c.comm).toLowerCase();
      if (base.includes("claude") || base === "node") return base;
      queue.push(c.pid);
    }
  }
  return null;
}
