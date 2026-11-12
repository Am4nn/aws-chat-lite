import { afterEach, describe, it, expect, vi } from "vitest";
import { bff, bffOrNull } from "./bff";

const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe("bffOrNull (a missing resource is a normal answer, any other failure is still an error)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the body on success", async () => {
    respond(200, { code: "abc" });
    expect(await bffOrNull("/bff/api/rooms/r/invite")).toEqual({ code: "abc" });
  });

  it("returns null on 404", async () => {
    respond(404, { error: "No active invite link." });
    expect(await bffOrNull("/bff/api/rooms/r/invite")).toBeNull();
  });

  it("throws the server's message on any other failure", async () => {
    respond(500, { error: "Something went wrong." });
    await expect(bffOrNull("/bff/api/rooms/r/invite")).rejects.toThrow("Something went wrong.");
  });
});

describe("bff, once the session can't be refreshed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the user to sign in and back to the same address, query included", async () => {
    respond(401, { error: "Not signed in." });
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/r/r1/t/3", search: "?view=map&run=abc", assign } });
    await expect(bff("/bff/api/rooms/r1")).rejects.toThrow("Signed out.");
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/r/r1/t/3?view=map&run=abc")}`);
  });
});
