import { useSyncExternalStore, useCallback } from "react";

export interface Annotation {
  id: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  comment: string;
  side: "left" | "right";
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
      comment: string,
      side: "left" | "right"
    ) => {
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        selectedText,
        startOffset,
        endOffset,
        comment,
        side,
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

function formatAnnotation(a: Annotation, idx: number): string {
  const truncated =
    a.selectedText.length > MESSAGE_TRUNCATE_LEN
      ? a.selectedText.slice(0, MESSAGE_TRUNCATE_LEN) + "..."
      : a.selectedText;
  return `${idx}. Regarding: "${truncated}"\n   → ${a.comment}`;
}

export function generateMessage(version: PlanVersion): string {
  if (version.annotations.length === 0) return "";

  const current = version.annotations.filter((a) => a.side === "right");
  const previous = version.annotations.filter((a) => a.side === "left");

  // If all annotations are on the same side, skip the section headers
  if (previous.length === 0) {
    const lines = current.map((a, i) => formatAnnotation(a, i + 1));
    return `I have some changes to the plan:\n\n${lines.join("\n\n")}`;
  }
  if (current.length === 0) {
    const lines = previous.map((a, i) => formatAnnotation(a, i + 1));
    return `I have some notes on the previous version of the plan:\n\n${lines.join("\n\n")}`;
  }

  const sections: string[] = [];
  let idx = 1;

  const currentLines = current.map((a) => formatAnnotation(a, idx++));
  sections.push(`On the current version:\n\n${currentLines.join("\n\n")}`);

  const previousLines = previous.map((a) => formatAnnotation(a, idx++));
  sections.push(`On the previous version:\n\n${previousLines.join("\n\n")}`);

  return `I have some changes to the plan:\n\n${sections.join("\n\n")}`;
}
