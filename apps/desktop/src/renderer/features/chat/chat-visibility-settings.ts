import { createPersistedValue } from "@/renderer/lib/external-value";

const store = createPersistedValue<boolean>("plan.showChats", (raw) =>
  typeof raw === "boolean" ? raw : true,
);

export const getShowChats = store.get;

export function useShowChats(): [boolean, (next: boolean) => void] {
  return [store.useValue(), store.set];
}

export const useShowChatsEnabled = store.useValue;
