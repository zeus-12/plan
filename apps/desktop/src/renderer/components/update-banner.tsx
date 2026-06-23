import { useEffect, useState } from "react";
import { ArrowDownToLine, X } from "lucide-react";
import type { UpdateInfo } from "../../shared-types";

// Remember which version the user dismissed so we don't nag again for it. A
// newer release later overrides this naturally (different version string).
const DISMISSED_KEY = "update-dismissed-version";

/**
 * A non-intrusive "update available" card. It only ever appears when the main
 * process confirms — via the GitHub Releases feed — that a strictly newer
 * version exists. It links to the download; it does NOT install (the app is
 * unsigned, so a real auto-install can't be done honestly).
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .checkForUpdate()
      .then((info) => {
        if (cancelled || !info) return;
        if (localStorage.getItem(DISMISSED_KEY) === info.version) return;
        setUpdate(info);
      })
      .catch(() => {
        // checkForUpdate already swallows failures into null; this is belt-and-
        // braces so a renderer-side reject never shows a phantom banner.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, update.version);
    setUpdate(null);
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[12px] font-medium text-[var(--text)]">
          Update available
        </div>
        <button
          onClick={dismiss}
          title="Dismiss"
          className="-mr-1 -mt-0.5 rounded p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
        >
          <X size={13} />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
        Plan {update.version} is ready to download. The current build can&apos;t
        update itself, so install it by dragging the new app into Applications.
      </p>
      <button
        onClick={() => window.electronAPI.openUpdateDownload(update.url)}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
      >
        <ArrowDownToLine size={13} />
        Download {update.version}
      </button>
    </div>
  );
}
