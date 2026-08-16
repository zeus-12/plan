import { createContext } from "react";

/**
 * The session's working directory, for anything inside a transcript that shows
 * a path. A context rather than a prop: the tool preview card sits at the end of
 * a memoized part view and inside a portal, and the cwd is one value per
 * session, not per row. Null means "unknown" — paths then stay absolute.
 */
export const SessionCwdContext = createContext<string | null>(null);
