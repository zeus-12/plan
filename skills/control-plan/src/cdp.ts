/**
 * Transport. Everything here is app-agnostic: open a CDP session, run
 * expressions, synthesise input, and refuse to measure a window that is not
 * really rendering.
 *
 * No dependencies — Node's global fetch and WebSocket speak the protocol.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** The page must belong to the app under test. Another Electron app answering
 *  the same port would otherwise be measured in silence. */
const APP_TITLE = /^plan$/i;

export interface Guard {
  hidden: boolean;
  focus: boolean;
  raf: "live" | "SUSPENDED";
  build: "preview" | "dev";
}

export interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  on(method: string, handler: (params: any) => void): void;
  guard(): Promise<Guard>;
  click(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  key(name: string, opts?: { meta?: boolean }): Promise<void>;
  /**
   * One half of a keystroke. A gesture that HOLDS a modifier needs the down and
   * the up as separate calls: Ctrl+Tab cycles on the taps but commits on the
   * Ctrl release, so a fused press-and-release measures the wrong moment.
   */
  keyEvent(
    type: "rawKeyDown" | "keyUp",
    key: { key: string; code: string; vk: number },
    modifiers?: number,
  ): Promise<void>;
  type(text: string): Promise<void>;
  close(): void;
}

/** CDP's modifier bitmask. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export class GuardFailure extends Error {
  readonly state: Guard;
  constructor(state: Guard) {
    super(
      `GUARD FAILED — refusing to measure: ${JSON.stringify(state)}\n` +
        `The window is hidden or minimised, so requestAnimationFrame is ` +
        `suspended and every per-frame number would be an artifact.`,
    );
    this.state = state;
  }
}

async function targets(port: number): Promise<any[] | null> {
  const res = await fetch(`http://127.0.0.1:${port}/json`).catch(() => null);
  return res ? ((await res.json()) as any[]) : null;
}

export async function isUp(port: number): Promise<boolean> {
  return (await targets(port)) !== null;
}

export async function connect(port: number): Promise<Session> {
  const list = await targets(port);
  if (!list) {
    throw new Error(
      `nothing answering CDP on ${port}. Start one with: control-plan launch`,
    );
  }
  const pages = list.filter((t) => t.type === "page");
  const page = pages.find((t) => APP_TITLE.test(String(t.title ?? "").trim()));
  if (!page) {
    throw new Error(
      `no Plan window on ${port}. Saw: ` +
        (pages.map((p) => `${p.title} @ ${p.url}`).join(", ") || "nothing") +
        `\nRefusing to drive another app's window.`,
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>();
  const listeners = new Map<string, ((p: any) => void)[]>();

  ws.addEventListener("message", (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data));
    if (m.id === undefined) {
      for (const h of listeners.get(m.method) ?? []) h(m.params);
      return;
    }
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket failed")), {
      once: true,
    });
  });

  const send: Session["send"] = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
    return r.result?.result?.value as T;
  };

  /**
   * `hidden` is the only state that invalidates a run: it suspends rAF, so a
   * per-frame harness hangs instead of failing.
   *
   * Focus is reported, never required, and the window is never raised. CDP
   * delivers input to the page rather than through the OS, and the instance is
   * launched with occlusion backgrounding off, so it keeps rendering while
   * completely covered. Raising it would only steal focus from whoever is
   * actually using the machine.
   */
  const guard: Session["guard"] = async () => {
    const g = await evaluate<Guard>(`(async () => {
      const raf = await Promise.race([
        new Promise((r) => requestAnimationFrame(() => r("live"))),
        new Promise((r) => setTimeout(() => r("SUSPENDED"), 1500)),
      ]);
      return { hidden: document.hidden, focus: document.hasFocus(), raf,
               build: location.protocol === "file:" ? "preview" : "dev" };
    })()`);
    if (g.hidden || g.raf !== "live") throw new GuardFailure(g);
    return g;
  };

  const click: Session["click"] = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
        pointerType: "mouse",
      });
      await sleep(25);
    }
  };

  const wheel: Session["wheel"] = async (x, y, deltaY) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: "mouse",
    });
  };

  const key: Session["key"] = async (name, { meta = false } = {}) => {
    const single = name.length === 1;
    const base = {
      modifiers: meta ? 4 : 0,
      key: name,
      code: single ? `Key${name.toUpperCase()}` : name,
      windowsVirtualKeyCode: single
        ? name.toUpperCase().charCodeAt(0)
        : undefined,
    };
    await send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  };

  const keyEvent: Session["keyEvent"] = async (type, k, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", {
      type,
      modifiers,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
    });
  };

  const type: Session["type"] = async (text) => {
    for (const ch of text) {
      await send("Input.dispatchKeyEvent", { type: "char", text: ch });
      await sleep(20);
    }
  };

  return {
    send,
    evaluate,
    on: (method, handler) => {
      listeners.set(method, [...(listeners.get(method) ?? []), handler]);
    },
    guard,
    click,
    wheel,
    key,
    keyEvent,
    type,
    close: () => ws.close(),
  };
}
