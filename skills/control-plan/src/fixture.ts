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

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

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

/** A second session in the SAME project, so a switch between two chats — the
 *  Ctrl+Tab gesture — has somewhere to land. Both are full size: the complaint
 *  is about big sessions, and a switch onto a small one measures nothing. */
export const FIXTURE_SESSION_ID_2 = "00000000-0000-4000-8000-000000000002";

/** A third, deliberately never opened. The switcher lists open tabs first and
 *  unopened sessions last, so a BACKWARD step always lands on this one however
 *  many stray tabs earlier checks left behind. */
export const FIXTURE_SESSION_ID_3 = "00000000-0000-4000-8000-000000000003";

/**
 * A synthetic chat transcript in the format the app reads.
 *
 * `seed` shifts the generated text so two sessions are not byte-identical —
 * identical content would let a shared cache serve the second one and hide
 * exactly the cost a switch is supposed to pay.
 */
export async function chatSession(
  ws: Workspace,
  rows: number,
  { sessionId = FIXTURE_SESSION_ID, seed = 0 } = {},
): Promise<{ sessionId: string; rows: number }> {
  // A fixed start time keeps rendered timestamps identical between runs.
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const lines: string[] = [];
  let parent: string | null = null;
  // Message uuids must not collide across sessions: the transcript's height
  // cache is keyed on the uuid, and a collision would let one session inherit
  // the other's measurements.
  const ns = sessionId.slice(-1);
  for (let i = 0; i < rows; i++) {
    const uuid = `00000000-0000-4000-900${ns}-${String(i).padStart(12, "0")}`;
    lines.push(
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        uuid,
        parentUuid: parent,
        timestamp: new Date(t0 + i * 60_000).toISOString(),
        cwd: ws.cwd,
        sessionId,
        message: { content: [{ type: "text", text: messageText(i + seed) }] },
      }),
    );
    parent = uuid;
  }
  await writeFile(
    join(ws.home, ".claude", "projects", ws.encoded, `${sessionId}.jsonl`),
    lines.join("\n") + "\n",
  );
  return { sessionId, rows };
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

/**
 * The file the diff fixture diffs. Two properties the renderer has to survive
 * are built in deliberately:
 *
 * - every fourth body line is long enough to wrap at a normal pane width, so
 *   rows are non-uniform once line wrap is on;
 * - the file is a run of indented function blocks, so the indentation folder
 *   finds regions and a fold test has something to collapse.
 *
 * Trailing whitespace on a fixed cadence gives "Ignore whitespace" something to
 * actually change.
 */
const fileOf = (lines: number, seed: number) => {
  const out: string[] = [];
  let k = 0;
  while (out.length < lines) {
    const fn = out.length;
    out.push(`export function block${fn}(input: number) {`);
    for (let j = 0; j < 10 && out.length < lines - 1; j++, k++) {
      const trail = k % 9 === 0 ? "   " : "";
      out.push(
        k % 4 === 0
          ? `  const line${k} = ${k + seed}; // ${body(k + seed, 40)}${trail}`
          : `  const line${k} = ${k + seed}; // ${body(k + seed, 6)}${trail}`,
      );
    }
    out.push(`  return input + ${fn};`);
    if (out.length < lines) out.push("}");
    if (out.length < lines) out.push("");
  }
  return out.slice(0, lines).join("\n") + "\n";
};

/**
 * A git repo with an uncommitted change, so the Diffs tab has something real to
 * open. `lines` is the file size and `changed` how many lines differ — a big
 * file with few changes is the case that hurts, because "All lines" renders the
 * whole file while "Changes only" renders almost none of it.
 */
export async function repoWithDiff(
  ws: Workspace,
  { lines = 3000, changed = 30, file = "large.ts" } = {},
): Promise<{ file: string; lines: number; changed: number }> {
  const git = (...args: string[]) =>
    exec("git", ["-C", ws.cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });

  await git("init", "-q", "-b", "main");
  await writeFile(join(ws.cwd, file), fileOf(lines, 0));
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture base");

  // Change a handful of lines spread through the file, so the diff has hunks
  // scattered across it rather than one block at the top. Only indented body
  // lines are touched: rewriting a `function` or `}` line would dissolve the
  // block, and with it the folds this fixture exists to provide.
  const edited = fileOf(lines, 0).split("\n");
  const stride = Math.max(1, Math.floor(lines / changed));
  for (let k = 0; k < changed; k++) {
    for (
      let at = k * stride;
      at < Math.min(edited.length, (k + 1) * stride);
      at++
    ) {
      if (!/^ {2}const line/.test(edited[at])) continue;
      edited[at] = `  const line${at} = ${at + 1}; // CHANGED ${body(at, 6)}`;
      break;
    }
  }
  await writeFile(join(ws.cwd, file), edited.join("\n"));
  return { file, lines, changed };
}
