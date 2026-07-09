import { execFile } from "child_process";
import { promisify } from "util";

/**
 * The one subprocess primitive for `git` and `gh`. Every module that shells
 * out goes through here, so buffer caps, stdin plumbing, and failure capture
 * are decided once. The return-shape adapters (`gitOrThrow`, `gitSafe`) exist
 * because callers legitimately differ in how they treat failure — a worktree
 * create aborts a multi-step flow (throw), a status poll degrades (capture) —
 * but they all share this single spawn implementation.
 */

const execFileP = promisify(execFile);

/** Output cap for captured stdout/stderr (diffs of large repos get big). */
const MAX_BUFFER = 32 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git with the given args in `cwd` (via `git -C`). Never throws — spawn
 * failure and non-zero exit are captured in `code`/`stderr`. `stdin` feeds
 * patch-apply-style commands; `timeoutMs` kills hung invocations (reported as
 * a non-zero `code`).
 */
export async function git(
  cwd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  try {
    const proc = execFile("git", ["-C", cwd, ...args], {
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeoutMs,
    });
    if (opts.stdin) {
      proc.stdin?.on("error", () => {}); // EPIPE when git exits early
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    }
    const { stdout, stderr } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      let out = "";
      let err = "";
      proc.stdout?.on("data", (c) => (out += c.toString()));
      proc.stderr?.on("data", (c) => (err += c.toString()));
      proc.on("error", reject);
      proc.on("close", () => resolve({ stdout: out, stderr: err }));
    });
    // exitCode is null when the process died on a signal (e.g. timeout kill) —
    // that's a failure, not a success.
    return { stdout, stderr, code: proc.exitCode ?? 1 };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    };
  }
}

/**
 * Run git; throws on non-zero exit with the trimmed stderr as the message.
 * For multi-step flows where any failure aborts the whole operation.
 */
export async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error((r.stderr || "git failed").trim());
  return r.stdout;
}

/** Run git, capturing the outcome as a boolean instead of throwing. */
export async function gitSafe(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await git(cwd, args);
  return {
    ok: r.code === 0,
    stdout: r.stdout,
    stderr: r.code === 0 ? r.stderr : (r.stderr || "git failed").trim(),
  };
}

/** `git show <rev>:<path>` → blob text, or "" if it doesn't exist there.
 *  An empty `rev` reads the index version (`git show :path`). */
export async function gitShow(
  cwd: string,
  rev: string,
  path: string,
): Promise<string> {
  const r = await git(cwd, ["show", `${rev}:${path}`]);
  return r.code === 0 ? r.stdout : "";
}

/** `git show <rev>:<path>` as raw bytes (images), or null if it doesn't exist
 *  there. Separate cap: image blobs run larger than text diffs. */
export async function gitShowBuffer(
  cwd: string,
  rev: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "show", `${rev}:${path}`],
      { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
    );
    return stdout as Buffer;
  } catch {
    return null;
  }
}

/** Run `gh` in `cwd`; never throws — non-zero exit is captured for the caller. */
export async function gh(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP("gh", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: (e.stderr || e.message || "gh failed").trim(),
    };
  }
}

const BINARY_PROBE_BYTES = 8000;

/** True when the text appears to be a binary blob (NUL bytes in the sample). */
export function looksBinary(s: string): boolean {
  const sample = s.slice(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}
