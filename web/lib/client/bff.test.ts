import { afterEach, describe, it, expect, vi } from "vitest";
import { bff, BffError, bffOrNull, errorText } from "./bff";
import { UserError } from "./errors";

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

describe("errorText (only our own words reach the user)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the message of an error we wrote: the server's answer, or one the app raised", () => {
    expect(errorText(new BffError(409, "#general already exists."))).toBe("#general already exists.");
    expect(errorText(new UserError("a.png didn't upload."))).toBe("a.png didn't upload.");
  });

  it("replaces any other error with the default, or the caller's own line, and logs it", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = new Error("User: arn:aws:sts::123456789012:assumed-role/cl-role/fn is not authorized");
    expect(errorText(denied)).toBe("Something went wrong.");
    expect(errorText(new TypeError("Failed to fetch"), "Notifications couldn't be changed.")).toBe("Notifications couldn't be changed.");
    expect(errorText("boom")).toBe("Something went wrong.");
    expect(logged.mock.calls.flat()).toContain(denied);
  });

  it("a fetch that never reached the server ends as the default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("NetworkError when attempting to fetch resource."); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorText(await bff("/bff/api/rooms").catch((e) => e))).toBe("Something went wrong.");
    vi.unstubAllGlobals();
  });
});
