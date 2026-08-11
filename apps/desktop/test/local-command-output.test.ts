import { describe, expect, it } from "vitest";
import {
  classifyMessage,
  isRealUserTurn,
  parseLocalCommandOutput,
  stripAnsi,
} from "@/renderer/features/chat/transcript/message-kind";
import type { ConversationMessage } from "@/common/shared-types";

const msg = (text: string): ConversationMessage => ({
  uuid: "u1",
  parentUuid: null,
  parentMessageUuid: null,
  role: "user",
  timestamp: "2026-08-11T10:00:00.000Z",
  parts: [{ kind: "text", text }],
});

describe("stripAnsi", () => {
  it("removes CSI style sequences", () => {
    expect(stripAnsi("Set model to \x1b[1mFable 5\x1b[22m and saved")).toBe(
      "Set model to Fable 5 and saved",
    );
  });

  it("removes OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07hello")).toBe("hello");
  });
});

describe("parseLocalCommandOutput", () => {
  it("parses a /model stdout turn and strips ANSI", () => {
    const r = parseLocalCommandOutput(
      "<local-command-stdout>Set model to  \x1b[1mFable 5\x1b[22m and saved as your default for new sessions</local-command-stdout>",
    );
    expect(r).toEqual({
      stdout:
        "Set model to  Fable 5 and saved as your default for new sessions",
      stderr: null,
    });
  });

  it("parses stderr", () => {
    const r = parseLocalCommandOutput(
      "<local-command-stderr>no such model</local-command-stderr>",
    );
    expect(r).toEqual({ stdout: null, stderr: "no such model" });
  });

  it("rejects ordinary prose mentioning the tag mid-text", () => {
    expect(
      parseLocalCommandOutput(
        "why does <local-command-stdout> render like that?",
      ),
    ).toBeNull();
  });

  it("rejects plain user text", () => {
    expect(parseLocalCommandOutput("hello there")).toBeNull();
  });
});

describe("classification", () => {
  it("treats a local-command output turn as machinery, not a user turn", () => {
    const m = msg(
      "<local-command-stdout>Set model to Fable 5</local-command-stdout>",
    );
    expect(classifyMessage(m)).toBe("tool");
    expect(isRealUserTurn(m)).toBe(false);
  });

  it("keeps a typed message a real user turn", () => {
    const m = msg("what does /model do?");
    expect(classifyMessage(m)).toBe("user-real");
    expect(isRealUserTurn(m)).toBe(true);
  });
});
