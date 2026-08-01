import { describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@/main/providers/claude-code/transcript";
import {
  isRetryableApiError,
  isSessionLimitError,
  recoveredAfter,
  retryableApiErrorAtEnd,
  sessionLimitAtEnd,
  sessionLimitResetText,
} from "@/renderer/features/chat/session/api-errors";
import type { ConversationMessage, ParsedSession } from "@/common/shared-types";

// The failures this feature exists for can't be provoked on demand, so the
// fixtures below are the real shapes Claude writes: assistant turns with
// `model: "<synthetic>"`, `isApiErrorMessage: true`, and its own `error` /
// `apiErrorStatus` classification. Each `errorLine` case was taken from an
// actual transcript.

const ts = (i: number) => `2026-07-11T10:00:${String(i).padStart(2, "0")}.000Z`;

const errorLine = (i: number, text: string, error: string, status?: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: `e-${i}`,
    parentUuid: null,
    sessionId: "sess-1",
    cwd: "/Users/x/proj",
    timestamp: ts(i),
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
    isApiErrorMessage: true,
    error,
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
  }) + "\n";

const replyLine = (i: number, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a-${i}`,
    parentUuid: null,
    sessionId: "sess-1",
    timestamp: ts(i),
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";

const userLine = (i: number, text: string) =>
  JSON.stringify({
    type: "user",
    uuid: `u-${i}`,
    parentUuid: null,
    sessionId: "sess-1",
    timestamp: ts(i),
    message: { content: text },
  }) + "\n";

const parse = (lines: string): ParsedSession =>
  parseSessionJsonl(lines, "/tmp/s.jsonl");

const only = (m: ConversationMessage[]) => m[m.length - 1];

describe("parsing API-error turns", () => {
  it("lifts Claude's error classification onto the message", () => {
    const s = parse(
      errorLine(1, "You've hit your session limit", "rate_limit", 429),
    );
    expect(only(s.messages).apiError).toEqual({
      kind: "rate_limit",
      status: 429,
    });
  });

  it("omits the status when the failure had none", () => {
    const s = parse(
      errorLine(
        1,
        "API Error: Connection closed mid-response. The response above may be incomplete.",
        "server_error",
      ),
    );
    expect(only(s.messages).apiError).toEqual({ kind: "server_error" });
  });

  it("leaves ordinary assistant turns unmarked", () => {
    const s = parse(replyLine(1, "Done — the tests pass."));
    expect(only(s.messages).apiError).toBeUndefined();
  });
});

describe("which failures are worth retrying", () => {
  const retryable: Array<[string, string]> = [
    [
      "API Error: Connection closed mid-response. The response above may be incomplete.",
      "server_error",
    ],
    ["API Error: Response stalled mid-stream.", "server_error"],
    ["API Error: Server error mid-response.", "server_error"],
    ["Request timed out", "server_error"],
    ["API Error: The socket connection was closed unexpectedly.", "unknown"],
    ["API Error: Stream idle timeout - no chunks received", "unknown"],
    ["API Error: Unable to connect to API (ConnectionRefused)", "unknown"],
  ];

  it.each(retryable)("retries %s", (text, kind) => {
    const s = parse(errorLine(1, text, kind));
    expect(isRetryableApiError(only(s.messages))).toBe(true);
  });

  // Re-sending into these fails identically and buries the message telling you
  // what to actually fix.
  const notRetryable: Array<[string, string, number | undefined]> = [
    ["You've hit your session limit · resets 4:30pm", "rate_limit", 429],
    ["Not logged in · Please run /login", "authentication_failed", undefined],
    ["Please run /login · API Error: 401", "authentication_failed", 401],
    [
      "There's an issue with the selected model (fable).",
      "model_not_found",
      404,
    ],
  ];

  it.each(notRetryable)("never retries %s", (text, kind, status) => {
    const s = parse(errorLine(1, text, kind, status));
    expect(isRetryableApiError(only(s.messages))).toBe(false);
  });

  it("leaves an unrecognised `unknown` alone rather than guessing", () => {
    const s = parse(errorLine(1, "API Error: something new", "unknown"));
    expect(isRetryableApiError(only(s.messages))).toBe(false);
  });
});

describe("is the session stuck right now", () => {
  const cutOff = errorLine(
    2,
    "API Error: Connection closed mid-response. The response above may be incomplete.",
    "server_error",
  );

  it("flags a transcript whose last turn is a recoverable failure", () => {
    const s = parse(userLine(1, "hi") + cutOff);
    expect(retryableApiErrorAtEnd(s)).not.toBeNull();
  });

  it("ignores a failure Claude already recovered from on its own", () => {
    const s = parse(userLine(1, "hi") + cutOff + replyLine(3, "ok"));
    expect(retryableApiErrorAtEnd(s)).toBeNull();
  });

  it("ignores a failure the user has already replied to", () => {
    const s = parse(userLine(1, "hi") + cutOff + userLine(3, "continue"));
    expect(retryableApiErrorAtEnd(s)).toBeNull();
  });

  it("does not offer to continue past a rate limit", () => {
    const s = parse(
      userLine(1, "hi") + errorLine(2, "session limit", "rate_limit", 429),
    );
    expect(retryableApiErrorAtEnd(s)).toBeNull();
  });

  it("handles an empty transcript", () => {
    expect(retryableApiErrorAtEnd(null)).toBeNull();
  });
});

describe("session limit — manual pill only, never auto-retried", () => {
  const limit = (i: number, text: string) =>
    errorLine(i, text, "rate_limit", 429);

  it("recognises a rate_limit turn as a session limit", () => {
    const s = parse(limit(1, "You've hit your session limit · resets 4:30pm"));
    expect(isSessionLimitError(only(s.messages))).toBe(true);
  });

  it("does not treat a transient failure as a session limit", () => {
    const s = parse(errorLine(1, "Request timed out", "server_error"));
    expect(isSessionLimitError(only(s.messages))).toBe(false);
  });

  it("flags a transcript parked on a session limit", () => {
    const s = parse(
      userLine(1, "hi") +
        limit(
          2,
          "You've hit your session limit · resets 3:10pm (Asia/Calcutta)",
        ),
    );
    expect(sessionLimitAtEnd(s)).not.toBeNull();
  });

  it("stops flagging once the user replies past it", () => {
    const s = parse(
      userLine(1, "hi") + limit(2, "session limit") + userLine(3, "continue"),
    );
    expect(sessionLimitAtEnd(s)).toBeNull();
  });

  it("never confuses a session limit with a retryable error", () => {
    // The two pills are mutually exclusive: the watcher's retry path must skip
    // this, and the manual path must own it.
    const s = parse(limit(1, "You've hit your session limit · resets 8:40pm"));
    expect(retryableApiErrorAtEnd(s)).toBeNull();
    expect(sessionLimitAtEnd(s)).not.toBeNull();
  });

  it("extracts the reset clause for display", () => {
    const s = parse(
      limit(1, "You've hit your session limit · resets 3:10pm (Asia/Calcutta)"),
    );
    expect(sessionLimitResetText(only(s.messages))).toBe(
      "resets 3:10pm (Asia/Calcutta)",
    );
  });

  it("returns null when the line has no reset clause to read", () => {
    const s = parse(limit(1, "You've hit your session limit"));
    expect(sessionLimitResetText(only(s.messages))).toBeNull();
  });
});

describe("re-arming after a nudge", () => {
  const cutOff = (i: number) =>
    errorLine(i, "API Error: Connection closed mid-response.", "server_error");

  it("re-arms once a real turn lands past the failure we retried", () => {
    // error → our nudge → Claude answers → it dies again later. The second
    // failure is a NEW stuck point and deserves its own single retry.
    const s = parse(
      cutOff(1) +
        userLine(2, "Please continue") +
        replyLine(3, "ok") +
        cutOff(4),
    );
    expect(recoveredAfter(s.messages, "e-1")).toBe(true);
  });

  it("stays spent when the nudge itself died again", () => {
    // error → our nudge → straight into another failure. Retrying here would
    // ping-pong, so the pill takes over instead.
    const s = parse(cutOff(1) + userLine(2, "Please continue") + cutOff(3));
    expect(recoveredAfter(s.messages, "e-1")).toBe(false);
  });

  it("stays spent while nothing has come back at all", () => {
    const s = parse(cutOff(1) + userLine(2, "Please continue"));
    expect(recoveredAfter(s.messages, "e-1")).toBe(false);
  });

  it("treats an unfindable uuid as not recovered", () => {
    const s = parse(replyLine(1, "ok"));
    expect(recoveredAfter(s.messages, "e-999")).toBe(false);
  });
});
