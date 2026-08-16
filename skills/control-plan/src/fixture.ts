/**
 * Synthetic worlds for the app to run in.
 *
 * `workspace()` is shared: it gives the app its own HOME with one project, so a
 * run never reads or writes real chats, projects or comments — every path the
 * app uses derives from homedir().
 *
 * The per-surface generators build the content each surface needs. `chatSession`
 * exists today; `repoFiles` seeds what a diff fixture will grow into.
 *
 * All content derives from an index, never from randomness or the clock, so two
 * runs produce byte-identical fixtures and a timing is comparable across days.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Claude's cwd → project-dir encoding: every non-alphanumeric char becomes "-". */
export const encodeCwd = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, "-");

const WORDS = [
  "fingerprint",
  "diagnostic",
  "session",
  "resolve",
  "policy",
  "server",
  "catalog",
  "handshake",
  "transcript",
  "window",
  "anchor",
  "measure",
  "reservation",
  "viewport",
  "index",
  "match",
  "render",
  "layout",
];

/** Deterministic pseudo-text: same index in, same words out, always. */
export function body(i: number, len: number): string {
  const out: string[] = [];
  for (let k = 0; k < len; k++)
    out.push(WORDS[(i * 7 + k * 13) % WORDS.length]);
  return out.join(" ");
}

export interface Workspace {
  dir: string;
  /** Pass to `launch --home` to isolate the app. */
  home: string;
  /** The project's working directory. */
  cwd: string;
  encoded: string;
}

/** A private HOME with one project registered. */
export async function workspace(dir: string): Promise<Workspace> {
  const home = join(dir, "home");
  const cwd = join(dir, "repo");
  const encoded = encodeCwd(cwd);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(home, ".claude", "projects", encoded), { recursive: true });
  await mkdir(join(home, ".plan"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { dir, home, cwd, encoded };
}

/** Register the project and any session names, once all content is written. */
export async function writeProjects(
  ws: Workspace,
  sessionNames: Record<string, string> = {},
): Promise<void> {
  await writeFile(
    join(ws.home, ".plan", "projects.json"),
    JSON.stringify({
      manualCwds: [ws.cwd],
      archivedEncoded: [],
      archivedSessions: [],
      sessionNames,
    }),
  );
}

/**
 * Rows vary in height the way a real chat does — short tool-ish lines, ordinary
 * prose, and the occasional very tall block — because a windowing bug only
 * shows up when heights differ.
 */
function messageText(i: number): string {
  const shape = i % 20;
  if (shape === 0) {
    return [
      `## Section ${i}`,
      "",
      body(i, 60),
      "",
      "```ts",
      ...Array.from(
        { length: 18 },
        (_, k) => `const value${k} = ${i * k}; // ${body(i + k, 6)}`,
      ),
      "```",
      "",
      body(i + 1, 40),
    ].join("\n");
  }
  if (shape % 5 === 0) return body(i, 3);
  return body(i, 18 + (i % 11) * 4);
}

export const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** A synthetic chat transcript in the format the app reads. */
export async function chatSession(
  ws: Workspace,
  rows: number,
): Promise<{ sessionId: string; rows: number }> {
  // A fixed start time keeps rendered timestamps identical between runs.
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < rows; i++) {
    const uuid = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
    lines.push(
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        uuid,
        parentUuid: parent,
        timestamp: new Date(t0 + i * 60_000).toISOString(),
        cwd: ws.cwd,
        sessionId: FIXTURE_SESSION_ID,
        message: { content: [{ type: "text", text: messageText(i) }] },
      }),
    );
    parent = uuid;
  }
  await writeFile(
    join(
      ws.home,
      ".claude",
      "projects",
      ws.encoded,
      `${FIXTURE_SESSION_ID}.jsonl`,
    ),
    lines.join("\n") + "\n",
  );
  return { sessionId: FIXTURE_SESSION_ID, rows };
}

/** Files for the diff and file tabs to open. */
export async function repoFiles(ws: Workspace, lines = 400): Promise<void> {
  await writeFile(
    join(ws.cwd, "sample.ts"),
    Array.from(
      { length: lines },
      (_, k) => `export const line${k} = ${k}; // ${body(k, 5)}`,
    ).join("\n") + "\n",
  );
}
