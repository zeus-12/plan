/**
 * Claude Code's API-error turns, and which of them are worth retrying.
 *
 * When a request fails, Claude writes a real transcript line for it — an
 * assistant turn with `model: "<synthetic>"` carrying `isApiErrorMessage: true`
 * plus its own `error` classification (and an HTTP status when there was one).
 * So "did this turn fail?" is a field we read, never a string we guess at; the
 * parser lifts those fields onto `ConversationMessage.apiError`.
 *
 * What text matching IS used for: splitting the deliberately vague `unknown`
 * bucket. Claude files transport failures there alongside everything else it
 * can't classify, so we retry only the transport ones we've actually observed.
 * The list below is a closed allowlist — an unrecognised `unknown` is left
 * alone rather than optimistically retried.
 *
 * Only transient failures are retryable. A rate limit, a logged-out CLI, or a
 * bad model name will fail identically on the next attempt, so re-sending into
 * them just burns the request and buries the real message telling you what to
 * fix. Those are never auto-continued.
 *
 * No Electron/Node imports (both main and renderer pull from here), same as
 * terminal-ids and ipc-contract.
 */

import type { ConversationMessage, ParsedSession } from "./shared-types";

/** Claude's `error` values seen on real transcripts. `unknown` is its catch-all. */
export type ApiErrorKind =
  | "server_error"
  | "rate_limit"
  | "authentication_failed"
  | "model_not_found"
  | "unknown"
  | (string & {});

export interface ApiErrorInfo {
  kind: ApiErrorKind;
  /** HTTP status, when the failure had one (429, 401, 404…). */
  status?: number;
}

/**
 * Transport failures Claude files under `unknown`. Everything in `server_error`
 * is already retryable on its own, so this list only has to cover the ones that
 * land in the catch-all: a dropped socket, a stream that went silent, and a
 * connection that never opened.
 */
const RETRYABLE_UNKNOWN = [
  /socket connection was closed unexpectedly/i,
  /stream idle timeout/i,
  /unable to connect to api/i,
];

/** The visible text of a turn — what Claude printed for the failure. */
export function messageText(msg: ConversationMessage): string {
  return msg.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Whether this turn is a failure that a plain "Please continue" can recover:
 * the response was cut off mid-flight and asking again should just work.
 */
export function isRetryableApiError(msg: ConversationMessage): boolean {
  const err = msg.apiError;
  if (!err) return false;
  // Connection closed mid-response, response stalled mid-stream, server error
  // mid-response, request timed out — all genuinely transient.
  if (err.kind === "server_error") return true;
  if (err.kind === "unknown") {
    const text = messageText(msg);
    return RETRYABLE_UNKNOWN.some((re) => re.test(text));
  }
  // rate_limit / authentication_failed / model_not_found and anything new:
  // retrying can't fix them, so don't.
  return false;
}

/**
 * The transcript's final turn, if it's a retryable failure — i.e. the session
 * is sitting stuck right now. Anything after the error (Claude recovered on its
 * own, or the user already replied) means there is nothing to continue.
 */
export function retryableApiErrorAtEnd(
  session: ParsedSession | null | undefined,
): ConversationMessage | null {
  const messages = session?.messages;
  if (!messages || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return null;
  return isRetryableApiError(last) ? last : null;
}

/**
 * Whether the session recovered after the failure we already retried: a real
 * assistant turn (not another failure) landed past `uuid`. That's the signal
 * that the stuck point is behind us and a later failure is a NEW one, worth its
 * own single retry. If we can't find `uuid` at all, treat it as not recovered —
 * better to under-retry than to loop.
 */
export function recoveredAfter(
  messages: ConversationMessage[],
  uuid: string,
): boolean {
  const at = messages.findIndex((m) => m.uuid === uuid);
  if (at < 0) return false;
  return messages
    .slice(at + 1)
    .some((m) => m.role === "assistant" && !m.apiError);
}
