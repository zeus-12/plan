import { useCallback, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Annotation } from "@plan/shared/lib/store";
import type { ChatAnnotation } from "../components/message-list";

/**
 * In-progress comments (diff annotations + chat annotations) keyed by project
 * `encoded`. Lives at module scope so it survives `ProjectWorkspace` remounts —
 * the workspace is keyed by `encoded` in App, so without this the comments
 * would be lost every time the user switches projects in the first sidebar.
 */
interface ProjectAnnotations {
  byFile: Record<string, Annotation[]>;
  chat: ChatAnnotation[];
}

const EMPTY: ProjectAnnotations = { byFile: {}, chat: [] };

const store = new Map<string, ProjectAnnotations>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot — returns the same reference until the project is mutated. */
function get(encoded: string): ProjectAnnotations {
  return store.get(encoded) ?? EMPTY;
}

export function useProjectAnnotations(encoded: string): {
  annotationsByFile: Record<string, Annotation[]>;
  setAnnotationsByFile: Dispatch<SetStateAction<Record<string, Annotation[]>>>;
  chatAnnotations: ChatAnnotation[];
  setChatAnnotations: Dispatch<SetStateAction<ChatAnnotation[]>>;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => get(encoded),
    () => get(encoded)
  );

  const setAnnotationsByFile = useCallback<
    Dispatch<SetStateAction<Record<string, Annotation[]>>>
  >(
    (update) => {
      const cur = get(encoded);
      const next =
        typeof update === "function" ? update(cur.byFile) : update;
      store.set(encoded, { ...cur, byFile: next });
      emit();
    },
    [encoded]
  );

  const setChatAnnotations = useCallback<
    Dispatch<SetStateAction<ChatAnnotation[]>>
  >(
    (update) => {
      const cur = get(encoded);
      const next = typeof update === "function" ? update(cur.chat) : update;
      store.set(encoded, { ...cur, chat: next });
      emit();
    },
    [encoded]
  );

  return {
    annotationsByFile: snapshot.byFile,
    setAnnotationsByFile,
    chatAnnotations: snapshot.chat,
    setChatAnnotations,
  };
}
