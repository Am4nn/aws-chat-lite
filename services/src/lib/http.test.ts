import { describe, it, expect, vi } from "vitest";
import { FlowFailed, Forbidden, Unavailable, Upstream } from "./errors.js";
import { errorResponse, siteCallback } from "./http.js";

describe("errorResponse", () => {
  it("answers a busy table with 503 and its message", () => {
    expect(errorResponse(new Unavailable("busy"))).toMatchObject({ statusCode: 503, body: JSON.stringify({ error: "busy" }) });
  });

  it("answers a failing remote server with 502 and its message", () => {
    expect(errorResponse(new Upstream("x.example didn't answer."))).toMatchObject({ statusCode: 502 });
  });

  it("answers a failed sign-in flow as its error, naming the room the browser goes back to", () => {
    expect(errorResponse(new FlowFailed("r1", new Forbidden("No.")))).toMatchObject({ statusCode: 403, body: JSON.stringify({ error: "No.", roomId: "r1" }) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorResponse(new FlowFailed("r1", new Error("bug")))).toMatchObject({
      statusCode: 500, body: JSON.stringify({ error: "Something went wrong.", roomId: "r1" }),
    });
    vi.restoreAllMocks();
  });
});

describe("siteCallback", () => {
  it("takes only a return address on one of the site's own origins", () => {
    process.env.SITE_ORIGINS = "http://localhost:3000,https://chat.example";
    expect(siteCallback("https://chat.example/bff/github/callback", "/bff/github/callback")).toBe("https://chat.example/bff/github/callback");
    for (const uri of ["https://evil.example/bff/github/callback", "https://chat.example/bff/mcp/callback", undefined, 7]) {
      expect(() => siteCallback(uri, "/bff/github/callback")).toThrow("That isn't chat-lite's sign-in return address.");
    }
  });
});
