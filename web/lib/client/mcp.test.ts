import { describe, expect, it } from "vitest";
import type { McpConnection, McpToolInfo } from "../types";
import { callbackTarget, keptLine, toolLabel } from "./mcp";

const tool = (name: string, readOnly = false): McpToolInfo => ({ name, description: "", inputSchema: {}, readOnly });
const conn = (over: Partial<McpConnection> = {}): McpConnection => ({
  name: "test", url: "https://mcp.example/mcp", auth: "oauth", status: "connected", tools: [tool("echo", true)], toolCount: 1,
  toolsAt: "2026-11-11T12:00:00Z", addedBy: "aman", addedAt: "2026-11-11T12:00:00Z", ...over,
});

describe("toolLabel", () => {
  it("says which tools run at once and which ask first", () => {
    expect(toolLabel(tool("echo", true))).toBe("read-only");
    expect(toolLabel(tool("add_note"))).toBe("asks first");
  });
});

describe("keptLine", () => {
  it("says how many tools the snapshot kept when the server listed more", () => {
    const tools = Array.from({ length: 40 }, (_, i) => tool(`t${i}`));
    expect(keptLine(conn({ tools, toolCount: 45 }))).toBe("40 of 45 tools kept");
  });
  it("says nothing when every tool was kept", () => expect(keptLine(conn())).toBeNull());
});

describe("callbackTarget", () => {
  it("returns to the room with the connected server's name", () => {
    expect(callbackTarget({ status: 200, body: { roomId: "r1", connection: conn() } })).toBe("/r/r1?mcp=test");
  });
  it("returns to the room with the error when the flow named one", () => {
    expect(callbackTarget({ status: 403, body: { roomId: "r1", error: "Finish connecting as the admin who started it." } }))
      .toBe("/r/r1?mcpError=Finish+connecting+as+the+admin+who+started+it.");
  });
  it("returns home with the error when the flow was unknown", () => {
    expect(callbackTarget({ status: 410, body: { error: "This connection attempt expired. Try again." } }))
      .toBe("/?mcpError=This+connection+attempt+expired.+Try+again.");
  });
});
