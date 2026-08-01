/**
 * Shared wiring for the global session notifiers (done + needs-approval).
 *
 * Both notifiers run at module scope and watch every live session, so neither
 * can reach into React for a project name or the navigation handlers. The app
 * root sets these once from the live projects list / its router; the notifiers
 * read them. Kept in one module so the two notifiers share a single source of
 * truth instead of each carrying its own copy.
 *
 * A chat pty's id is `chat:<encoded>:<sessionId>`.
 */

// Resolve a chat pty id to a human label for the notification body: the chat's
// title when one is known, else the repo it lives in. Set by the app root.
let resolveLabel: (id: string) => string = () => "Claude";

export function setSessionLabelResolver(fn: (id: string) => string) {
  resolveLabel = fn;
}

export function sessionLabel(id: string): string {
  return resolveLabel(id);
}

// Jump to the session a notification is about. Set by the app root (it owns the
// project/session navigation); null until then.
let navigate: ((id: string) => void) | null = null;

export function setSessionNavigator(fn: (id: string) => void) {
  navigate = fn;
}

/** The navigator, or null before the app root has wired one. */
export function sessionNavigator(): ((id: string) => void) | null {
  return navigate;
}
