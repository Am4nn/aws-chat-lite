import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors.js";
import { browserUrl, localHosts, mcpServerUrl, ownMcpUrls } from "./url.js";

describe("mcpServerUrl", () => {
  it("refuses keys in the query, and keeps other parameters", () => {
    expect(() => mcpServerUrl("https://x.com/mcp?api_key=1", [])).toThrow(
      new ValidationError("Don't put keys in the URL: chat-lite signs in with OAuth."),
    );
    expect(mcpServerUrl("https://x.com/mcp?profile=a", []).href).toBe("https://x.com/mcp?profile=a");
  });

  it("allows http only for a local host", () => {
    expect(mcpServerUrl("http://host.docker.internal:4710/mcp", ["host.docker.internal"]).port).toBe("4710");
    expect(() => mcpServerUrl("http://host.docker.internal:4710/mcp", [])).toThrow(new ValidationError("Use an https URL."));
  });

  it("allows any https port", () => {
    expect(mcpServerUrl("https://x.com:8443/mcp", []).port).toBe("8443");
  });

  it("refuses userinfo, a private address and anything that isn't a URL", () => {
    expect(() => mcpServerUrl("https://u:p@x.com/mcp", [])).toThrow("Links with a username or password aren't allowed.");
    expect(() => mcpServerUrl("https://10.0.0.1/mcp", [])).toThrow("That address is private.");
    expect(() => mcpServerUrl("https://[::1]/mcp", [])).toThrow("That address is private.");
    expect(mcpServerUrl("http://127.0.0.1:4710/mcp", ["127.0.0.1"]).hostname).toBe("127.0.0.1");
    expect(() => mcpServerUrl(42, [])).toThrow("That isn't a valid URL.");
    expect(() => mcpServerUrl("not a url", [])).toThrow("That isn't a valid URL.");
  });
});

describe("mcpServerUrl and chat-lite's own server", () => {
  const own = ownMcpUrls({ SITE_ORIGINS: "https://chat.amanarya.com,http://localhost:3000", MCP_BASE_URL: "http://api.local:4566/" });

  it("refuses chat-lite's own MCP server on any site origin or the MCP base, however it's written", () => {
    for (const raw of ["https://chat.amanarya.com/mcp", "https://CHAT.amanarya.com/mcp/", "https://chat.amanarya.com/mcp?x=1", "http://localhost:3000/mcp", "http://api.local:4566/mcp"]) {
      expect(() => mcpServerUrl(raw, ["localhost", "api.local"], own)).toThrow("That's chat-lite's own MCP server.");
    }
  });

  it("refuses path variants that reach the same endpoint", () => {
    for (const raw of ["https://chat.amanarya.com//mcp", "https://chat.amanarya.com/MCP", "https://chat.amanarya.com/%6dcp", "https://chat.amanarya.com:443/mcp"]) {
      expect(() => mcpServerUrl(raw, [], own), raw).toThrow("That's chat-lite's own MCP server.");
    }
  });

  it("skips malformed entries, and refuses nothing when nothing is configured", () => {
    expect(ownMcpUrls({ SITE_ORIGINS: "not a url,https://chat.amanarya.com", MCP_BASE_URL: "Token[TOKEN.1]" })).toEqual(["https://chat.amanarya.com/mcp"]);
    expect(ownMcpUrls({})).toEqual([]);
    expect(mcpServerUrl("https://chat.amanarya.com/mcp", [], ownMcpUrls({})).hostname).toBe("chat.amanarya.com");
  });

  it("allows other paths on those hosts, and other servers", () => {
    expect(mcpServerUrl("https://chat.amanarya.com/other/mcp", [], own).href).toBe("https://chat.amanarya.com/other/mcp");
    expect(mcpServerUrl("https://mcp.linear.app/mcp", [], own).hostname).toBe("mcp.linear.app");
  });
});

describe("browserUrl", () => {
  it("refuses schemes a browser would run, and URLs over 500 chars", () => {
    expect(() => browserUrl("javascript:alert(1)", [])).toThrow(new ValidationError("Use an https URL."));
    expect(() => browserUrl("data:text/html,hi", [])).toThrow(new ValidationError("Use an https URL."));
    const long = "https://x.com/" + "a".repeat(487);
    expect(long).toHaveLength(501);
    expect(() => browserUrl(long, [])).toThrow("That URL is over 500 characters.");
    expect(browserUrl(long.slice(0, 500), []).hostname).toBe("x.com");
  });
});

describe("localHosts", () => {
  it("reads MCP_LOCAL_HOSTS", () => {
    expect(localHosts({ MCP_LOCAL_HOSTS: "host.docker.internal, localhost,127.0.0.1" })).toEqual([
      "host.docker.internal",
      "localhost",
      "127.0.0.1",
    ]);
    expect(localHosts({})).toEqual([]);
  });
});
