import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@plan/shared/components/ui/alert-dialog";
import { Kbd } from "@plan/shared/components/ui/kbd";

const CODE_ID = "confirm-dialog-code";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Verbatim text the action will act on — a shell snippet about to be run,
   *  say. Shown monospaced so the user reads exactly what they're approving. */
  code?: string;
}

/**
 * Promise-based confirmation backed by the shadcn AlertDialog. Render the
 * returned `dialog` somewhere in the tree and `await confirm({...})` wherever
 * you'd otherwise call `window.confirm`.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setOpts(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(value);
  }, []);

  const dialog = (
    <AlertDialog
      open={opts !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent
        className={opts?.code ? "max-w-[560px]" : undefined}
        onKeyDown={(e) => {
          // Enter confirms (Radix defaults focus to Cancel, so we force it).
          if (e.key === "Enter") {
            e.preventDefault();
            settle(true);
          }
        }}
        // Radix wires this to the Description; without one it warns and points
        // at an element that isn't there.
        aria-describedby={opts?.description ? undefined : CODE_ID}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description && (
            <AlertDialogDescription>{opts.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {opts?.code && (
          <pre
            id={CODE_ID}
            className="max-h-[240px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-mono)] text-[12px] leading-[18px] text-[var(--text)]"
          >
            {opts.code}
          </pre>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction className="gap-2" onClick={() => settle(true)}>
            {opts?.confirmLabel ?? "Confirm"}
            <Kbd keys={["⌘", "⏎"]} />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
