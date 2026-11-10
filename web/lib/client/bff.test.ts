import { afterEach, describe, it, expect, vi } from "vitest";
import { bffOrNull } from "./bff";

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
