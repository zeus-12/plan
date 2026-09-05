"use client";

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";

/**
 * Non-modal by default. A modal menu wraps its content in a *trapped*
 * FocusScope, which listens for `focusin` anywhere in the document and drags
 * focus back inside itself. The content stays mounted through its close
 * animation, so a dialog opened from a menu item mounts and focuses its input
 * while that trap is still live, and the trap immediately takes it away — the
 * dialog opens unfocused. Non-modal drops the trap (Radix's own
 * MenuRootContentNonModal passes `trapFocus: false`) and keeps dismiss-on-
 * outside-click and Escape. Overridable per call site.
 */
const ContextMenu = ({
  modal = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) => (
  <ContextMenuPrimitive.Root modal={modal} {...props} />
);
ContextMenu.displayName = "ContextMenu";
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      // The other half of the same problem: on unmount FocusScope refocuses
      // whatever was focused before the menu opened, in a setTimeout(0) that
      // lands after a dialog the item opened has focused its input. Our
      // triggers are non-focusable rows, so the restore had nothing to return
      // to. Listed before the spread so a call site can still override it.
      onCloseAutoFocus={(e) => e.preventDefault()}
      className={cn(
        "z-50 min-w-[180px] overflow-hidden rounded-md border border-[var(--popover-border)] bg-[var(--popover-bg)] p-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] shadow-lg",
        "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    destructive?: boolean;
  }
>(({ className, destructive, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-[var(--bg-surface-hover)] data-[highlighted]:text-[var(--text)] data-[disabled]:opacity-50",
      destructive &&
        "text-[var(--removed-text)] data-[highlighted]:text-[var(--removed-text)]",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-[var(--border)]", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

/** Right-aligned key hint on a menu item (⌘C, Space…). Purely a label. */
function ContextMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "ml-auto pl-4 text-[10px] tracking-wide text-[var(--text-tertiary)]",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
};
