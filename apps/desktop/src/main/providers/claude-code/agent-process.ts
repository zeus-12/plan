import { getProcessTree } from "../../process-tree";

/**
 * Agent-process probing: find the agent (claude / its node host) among a pty
 * shell's descendants — node-pty's foreground-process name is unreliable on
 * macOS. The process tree itself (and its `ps` caching) belongs to
 * process-tree.ts; this is only the "which of these is the agent" question.
 */

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
