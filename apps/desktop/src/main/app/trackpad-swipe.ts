import { app, type BrowserWindow } from "electron";
import { join } from "path";
import type { SwipeGestureEvent } from "@/common/shared-types";

interface TrackpadSwipeAddon {
  start(handle: Buffer, cb: (e: SwipeGestureEvent) => void): number;
  stop(id: number): void;
}

let addon: TrackpadSwipeAddon | null | undefined;

function loadAddon(): TrackpadSwipeAddon | null {
  if (addon !== undefined) return addon;
  const path = app.isPackaged
    ? join(process.resourcesPath, "trackpad_swipe.node")
    : join(app.getAppPath(), "native/trackpad-swipe/build/trackpad_swipe.node");
  try {
    const mod = { exports: {} as TrackpadSwipeAddon };
    process.dlopen(mod, path);
    addon = mod.exports;
  } catch (err) {
    console.warn(
      `[trackpad-swipe] addon unavailable, swipe navigation disabled: ${String(err)}`,
    );
    addon = null;
  }
  return addon;
}

/**
 * Streams the window's two-finger trackpad scroll phases (began → changed →
 * ended/cancelled, momentum excluded) from an AppKit event monitor. Chromium
 * strips NSEvent phases before wheel events reach JS, so this needs native code.
 */
export function watchTrackpadSwipes(
  win: BrowserWindow,
  emit: (e: SwipeGestureEvent) => void,
): void {
  const native = loadAddon();
  if (!native) return;
  const id = native.start(win.getNativeWindowHandle(), (e) => {
    if (win.isDestroyed()) return;
    if (e.phase === "begin") {
      const zoom = win.webContents.getZoomFactor();
      emit({ ...e, x: e.x / zoom, y: e.y / zoom });
    } else {
      emit(e);
    }
  });
  win.on("closed", () => native.stop(id));
}
