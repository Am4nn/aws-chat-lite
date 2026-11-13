import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnv } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("serverEnv", () => {
  it("dictates in the browser only when the stage says so", () => {
    vi.stubEnv("DICTATION", "browser");
    expect(serverEnv().dictation).toBe("browser");
    vi.stubEnv("DICTATION", "anything");
    expect(serverEnv().dictation).toBe("transcribe");
    vi.stubEnv("DICTATION", undefined);
    expect(serverEnv().dictation).toBe("transcribe");
  });

  it("knows the MCP server's own address only when it is set, without a trailing slash", () => {
    vi.stubEnv("MCP_BASE_URL", "http://mcp.localhost:4566/");
    expect(serverEnv().mcpBaseUrl).toBe("http://mcp.localhost:4566");
    vi.stubEnv("MCP_BASE_URL", "");
    expect(serverEnv().mcpBaseUrl).toBeUndefined();
  });
});
