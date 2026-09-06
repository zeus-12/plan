/**
 * App lifecycle: start an instance, stop the one we started, and report whether
 * it is worth driving. App-agnostic apart from knowing this is an electron-vite
 * project.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, isUp, sleep } from "./cdp.ts";

/** Runtime state lives outside the repo: a pidfile next to the source would
 *  show up as a dirty working tree on every run. */
const STATE_DIR = join(homedir(), ".plan", "control-plan");
const pidFile = (port: number) => join(STATE_DIR, `plan-${port}.json`);

export interface LaunchOptions {
  port: number;
  repo: string;
  mode: "dev" | "preview";
  /** Build the renderer first (preview only). */
  build?: boolean;
  /** Run against an isolated HOME, so the app sees fixture data and nothing
   *  belonging to the person running this. */
  home?: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

export async function launch(opts: LaunchOptions) {
  if (await isUp(opts.port)) {
    throw new Error(
      `something already answers on ${opts.port}. Run: control-plan stop`,
    );
  }
  await mkdir(STATE_DIR, { recursive: true });
  if (opts.mode === "preview" && opts.build) {
    await run("npm", ["run", "build"], join(opts.repo, "apps/desktop"));
  }

  // electron-vite rejects unknown top-level flags; anything after `--` is
  // handed to Electron. Occlusion backgrounding must be off or the window stops
  // rendering the moment another window covers it, and rAF suspends.
  const args = [
    "electron-vite",
    opts.mode,
    "--",
    `--remote-debugging-port=${opts.port}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  const logPath = join(STATE_DIR, `plan-${opts.port}.log`);
  // `preview` MUST be the built renderer. The main process prefers
  // ELECTRON_RENDERER_URL whenever it is set, so an inherited one — left in the
  // shell by a dev server, possibly one belonging to a DIFFERENT checkout —
  // silently makes a "preview" run measure someone else's source. Strip it.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.home) env.HOME = opts.home;
  if (opts.mode === "preview") delete env.ELECTRON_RENDERER_URL;
  const child = spawn("npx", args, {
    cwd: join(opts.repo, "apps/desktop"),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d));
  child.unref();

  // Record what WE started, so `stop` never kills another Electron app.
  await writeFile(
    pidFile(opts.port),
    JSON.stringify({ pid: child.pid, port: opts.port, mode: opts.mode }),
  );

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(opts.port)) {
      await writeFile(logPath, Buffer.concat(chunks));
      return { launched: true, ...opts, pid: child.pid, log: logPath };
    }
    await sleep(1000);
  }
  await writeFile(logPath, Buffer.concat(chunks));
  throw new Error(`no CDP on ${opts.port} after 90s. See ${logPath}`);
}

export async function stop(port: number) {
  const f = pidFile(port);
  if (!existsSync(f)) {
    throw new Error(
      `no record of an instance started by this tool on ${port}.\n` +
        `Refusing to guess which process to kill — that is how an unrelated ` +
        `app gets terminated. Close the window by hand.`,
    );
  }
  const { pid } = JSON.parse(await readFile(f, "utf8")) as { pid: number };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await rm(f, { force: true });
  return { stopped: true, pid, port };
}

/** Read-only: is this instance worth driving, and which build is it? */
export async function doctor(port: number) {
  if (!(await isUp(port))) {
    return { cdp: false, port, advice: "control-plan launch --mode preview" };
  }
  const cdp = await connect(port);
  const state = await cdp.evaluate<any>(`(async () => {
    const raf = await Promise.race([
      new Promise((r) => requestAnimationFrame(() => r("live"))),
      new Promise((r) => setTimeout(() => r("SUSPENDED"), 1500)),
    ]);
    const panes = [...document.querySelectorAll(".chat-transcript")];
    return {
      hidden: document.hidden, focus: document.hasFocus(), raf,
      build: location.protocol === "file:" ? "preview (built)" : "dev (HMR, ~2x slower)",
      url: location.href,
      nodes: document.querySelectorAll("*").length,
      panes: panes.map((p) => ({
        visible: p.clientHeight > 0,
        rows: p.querySelectorAll("[data-msg-row]").length,
        scrollTop: Math.round(p.scrollTop),
        scrollHeight: Math.round(p.scrollHeight),
      })),
    };
  })()`);
  cdp.close();

  const warnings: string[] = [];
  if (state.hidden)
    warnings.push("window hidden — rAF suspended, measurements refused");
  if (state.raf !== "live") warnings.push("requestAnimationFrame not running");
  if (String(state.build).startsWith("dev")) {
    warnings.push(
      "dev build: React dev-mode inflates timings ~2x; measure preview",
    );
  }
  return {
    cdp: true,
    port,
    ...state,
    warnings,
    worthDriving: warnings.length === 0,
  };
}
