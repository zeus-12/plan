import { useCallback, useEffect, useRef, useState } from "react";
import { chatTerminalId } from "@/common/terminal-ids";
import { Button } from "@plan/shared/components/ui/button";
import { TextShimmer } from "@plan/shared/components/ui/text-shimmer";
import { TerminalPanel } from "@/renderer/features/terminal/terminal-panel";
import { useChatStarted } from "./session/chat-driver-store";

export function ChatTerminalPane({
  encoded,
  sessionId,
  active,
  onStart,
}: {
  encoded: string;
  sessionId: string;
  active: boolean;
  onStart: (sessionId: string) => Promise<boolean>;
}) {
  const tid = chatTerminalId(encoded, sessionId);
  const started = useChatStarted(tid);
  const [starting, setStarting] = useState(false);
  const autoStarted = useRef(false);

  const start = useCallback(() => {
    setStarting(true);
    void onStart(sessionId).finally(() => setStarting(false));
  }, [onStart, sessionId]);

  // Once per mount, so quitting Claude leaves the pane parked on the button
  // instead of immediately respawning it.
  useEffect(() => {
    if (!active || started || autoStarted.current) return;
    autoStarted.current = true;
    start();
  }, [active, started, start]);

  if (started) {
    return (
      <TerminalPanel
        id={tid}
        encoded={encoded}
        showHeader={false}
        visible={active}
      />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      {starting ? (
        <TextShimmer
          duration={2.4}
          className="font-[family-name:var(--font-mono)] text-[11px]"
        >
          Starting Claude…
        </TextShimmer>
      ) : (
        <Button size="sm" variant="outline" onClick={start}>
          Resume session
        </Button>
      )}
    </div>
  );
}
