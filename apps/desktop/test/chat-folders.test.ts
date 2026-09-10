import { describe, expect, it } from "vitest";
import {
  detachChat,
  foldersFor,
  withChatMoved,
  withFolderUpdated,
  withNewFolder,
  type StoredChatFolder,
} from "@/main/store/chat-folders";

const folder = (
  id: string,
  sessionIds: string[],
  encoded = "wt",
): StoredChatFolder => ({
  id,
  encoded,
  name: id,
  collapsed: false,
  sessionIds,
});

describe("detachChat", () => {
  it("returns the same array when the chat is in no folder", () => {
    const folders = [folder("a", ["s1"])];
    expect(detachChat(folders, "s2")).toBe(folders);
  });

  it("drops a folder the chat leaves empty", () => {
    const folders = [folder("a", ["s1"]), folder("b", ["s2", "s3"])];
    expect(detachChat(folders, "s1").map((f) => f.id)).toEqual(["b"]);
    expect(detachChat(folders, "s2")).toEqual([
      folder("a", ["s1"]),
      folder("b", ["s3"]),
    ]);
  });
});

describe("withNewFolder", () => {
  it("takes the chat out of its old folder", () => {
    const next = withNewFolder(
      [folder("a", ["s1"])],
      "wt",
      "  Auth  ",
      "s1",
      "b",
    );
    expect(next).toEqual([
      {
        id: "b",
        encoded: "wt",
        name: "Auth",
        collapsed: false,
        sessionIds: ["s1"],
      },
    ]);
  });

  it("rejects a blank name", () => {
    expect(() => withNewFolder([], "wt", "   ", "s1", "b")).toThrow();
  });
});

describe("withChatMoved", () => {
  it("moves a chat between folders, removing the emptied one", () => {
    const next = withChatMoved(
      [folder("a", ["s1"]), folder("b", ["s2"])],
      "wt",
      "s1",
      "b",
    );
    expect(next).toEqual([folder("b", ["s2", "s1"])]);
  });

  it("is a no-op when the chat is already in the target", () => {
    const folders = [folder("a", ["s1"])];
    expect(withChatMoved(folders, "wt", "s1", "a")).toBe(folders);
  });

  it("ungroups with a null target", () => {
    expect(
      withChatMoved([folder("a", ["s1", "s2"])], "wt", "s1", null),
    ).toEqual([folder("a", ["s2"])]);
  });

  it("refuses a folder from another worktree", () => {
    expect(() =>
      withChatMoved([folder("a", ["s1"], "other")], "wt", "s2", "a"),
    ).toThrow();
  });
});

describe("withFolderUpdated", () => {
  it("renames with a trimmed name and keeps members", () => {
    const [f] = withFolderUpdated([folder("a", ["s1"])], "wt", "a", {
      name: " Perf ",
    });
    expect(f).toMatchObject({ name: "Perf", sessionIds: ["s1"] });
  });

  it("toggles collapsed", () => {
    const [f] = withFolderUpdated([folder("a", ["s1"])], "wt", "a", {
      collapsed: true,
    });
    expect(f.collapsed).toBe(true);
  });

  it("rejects a blank rename", () => {
    expect(() =>
      withFolderUpdated([folder("a", ["s1"])], "wt", "a", { name: "" }),
    ).toThrow();
  });
});

describe("foldersFor", () => {
  it("scopes to one worktree and strips the encoded key", () => {
    const out = foldersFor(
      [folder("a", ["s1"]), folder("b", ["s2"], "other")],
      "wt",
    );
    expect(out).toEqual([
      { id: "a", name: "a", collapsed: false, sessionIds: ["s1"] },
    ]);
  });
});
