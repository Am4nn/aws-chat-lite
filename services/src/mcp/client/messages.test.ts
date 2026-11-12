import { describe, expect, it, vi } from "vitest";
import { remoteFailure } from "./messages.js";

describe("remoteFailure", () => {
  it("never passes on an error's own words, which could name our account or echo a token, and logs them", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = new Error("User: arn:aws:sts::123456789012:assumed-role/cl-role/fn is not authorized");
    expect(remoteFailure("mcp.example", denied)).toBe("mcp.example didn't answer.");
    expect(logged.mock.calls.flat()).toContain(denied);
    logged.mockRestore();
  });
});
