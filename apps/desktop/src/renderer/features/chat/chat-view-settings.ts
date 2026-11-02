import { createPersistedValue } from "@/renderer/lib/external-value";

const store = createPersistedValue<boolean>("plan.chatTerminalView", (raw) =>
  typeof raw === "boolean" ? raw : false,
);

export const getChatTerminalView = store.get;

export function useChatTerminalView(): [boolean, (next: boolean) => void] {
  return [store.useValue(), store.set];
}
