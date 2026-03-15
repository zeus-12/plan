import { useSyncExternalStore, useCallback } from "react";

export interface Annotation {
  id: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  comment: string;
}

export interface PlanVersion {
  id: string;
  text: string;
  annotations: Annotation[];
  createdAt: number;
}

interface Store {
  versions: PlanVersion[];
}

let store: Store = {
  versions: [],
};

const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return store;
}

export function useStore() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const addVersion = useCallback((text: string) => {
    const version: PlanVersion = {
      id: crypto.randomUUID(),
      text,
      annotations: [],
      createdAt: Date.now(),
    };
    store = { ...store, versions: [...store.versions, version] };
    emitChange();
  }, []);

  const addAnnotation = useCallback(
    (
      versionIndex: number,
      selectedText: string,
      startOffset: number,
      endOffset: number,
      comment: string
    ) => {
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        selectedText,
        startOffset,
        endOffset,
        comment,
      };
      const versions = store.versions.map((v, i) =>
        i === versionIndex
          ? { ...v, annotations: [...v.annotations, annotation] }
          : v
      );
      store = { ...store, versions };
      emitChange();
    },
    []
  );

  const updateAnnotation = useCallback(
    (versionIndex: number, annotationId: string, comment: string) => {
      const versions = store.versions.map((v, i) =>
        i === versionIndex
          ? {
              ...v,
              annotations: v.annotations.map((a) =>
                a.id === annotationId ? { ...a, comment } : a
              ),
            }
          : v
      );
      store = { ...store, versions };
      emitChange();
    },
    []
  );

  const removeAnnotation = useCallback(
    (versionIndex: number, annotationId: string) => {
      const versions = store.versions.map((v, i) =>
        i === versionIndex
          ? {
              ...v,
              annotations: v.annotations.filter((a) => a.id !== annotationId),
            }
          : v
      );
      store = { ...store, versions };
      emitChange();
    },
    []
  );

  const reset = useCallback(() => {
    store = { versions: [] };
    emitChange();
  }, []);

  return {
    ...state,
    addVersion,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    reset,
  };
}

const MESSAGE_TRUNCATE_LEN = 120;

export function generateMessage(version: PlanVersion): string {
  if (version.annotations.length === 0) return "";

  const lines = version.annotations.map((a, i) => {
    const truncated =
      a.selectedText.length > MESSAGE_TRUNCATE_LEN
        ? a.selectedText.slice(0, MESSAGE_TRUNCATE_LEN) + "..."
        : a.selectedText;
    return `${i + 1}. Regarding: "${truncated}"\n   → ${a.comment}`;
  });

  return `I have some changes to the plan:\n\n${lines.join("\n\n")}`;
}
