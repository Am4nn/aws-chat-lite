import { afterEach, describe, expect, it, vi } from "vitest";
import { callApi } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("callApi", () => {
  it("waits as long as the slowest API route may take, just under the HTTP API's 30 s cap", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    await callApi("/rooms", "id-token");
    expect(timeout).toHaveBeenCalledWith(29_000);
  });
});
