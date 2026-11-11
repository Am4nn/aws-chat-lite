import { describe, expect, it } from "vitest";
import type { McpApp } from "../types";
import { appLine, scopeLines } from "./apps";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const app = (scopes: McpApp["scopes"]): McpApp => ({
  grantId: "g1", clientName: "Claude Code", scopes, createdAt: "2026-11-08T12:00:00Z", lastUsedAt: "2026-11-11T11:55:00Z",
});

describe("scopeLines", () => {
  it("names what a read-only app may do", () => {
    expect(scopeLines(["rooms:read"])).toEqual(["Read your rooms, chats and threads"]);
  });

  it("lists reading before posting, whatever order the scopes came in", () => {
    expect(scopeLines(["rooms:write", "rooms:read"])).toEqual([
      "Read your rooms, chats and threads",
      "Post messages and start agent threads as you",
    ]);
  });
});

describe("appLine", () => {
  it("says a read-only app only reads", () => {
    expect(appLine(app(["rooms:read"]), NOW)).toBe("Claude Code · read only · added 3d ago · last used 5m ago");
  });

  it("says an app with both scopes reads and posts", () => {
    expect(appLine(app(["rooms:read", "rooms:write"]), NOW)).toBe("Claude Code · read and post · added 3d ago · last used 5m ago");
  });
});
