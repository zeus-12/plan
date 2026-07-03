"use client";

import * as React from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type PanelGroupProps,
  type PanelProps,
} from "react-resizable-panels";
import { cn } from "../../lib/utils";

const ResizablePanelGroup = ({ className, ...props }: PanelGroupProps) => (
  <PanelGroup
    className={cn(
      "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
      className,
    )}
    {...props}
  />
);

const ResizablePanel = (props: PanelProps) => <Panel {...props} />;

const ResizableHandle = ({
  className,
  withHandle = false,
}: {
  className?: string;
  withHandle?: boolean;
}) => (
  <PanelResizeHandle
    className={cn(
      "relative flex w-px items-center justify-center bg-[var(--border)] transition-colors hover:bg-[var(--border-strong)] data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[resize-handle-state=hover]:bg-[var(--border-strong)] data-[resize-handle-state=drag]:bg-[var(--border-strong)]",
      className,
    )}
  >
    {withHandle && (
      <div className="z-10 flex h-3 w-2 items-center justify-center rounded-sm border border-[var(--border)] bg-[var(--bg-surface)]" />
    )}
  </PanelResizeHandle>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
