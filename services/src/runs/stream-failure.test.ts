import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";

// No table is configured here, so reading the ticket throws: the stream fails before writing anything.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a run stream that fails before it starts", () => {
  it("the local server answers 500 with a JSON error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { startStreamServer } = await import("./stream-server.js");
    const server = startStreamServer(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/runs/r1/stream?ticket=t`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "The stream failed." });
    } finally {
      server.close();
    }
  });

  it("the Lambda answers 500 with a JSON error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const preludes: { statusCode: number }[] = [];
    vi.stubGlobal("awslambda", {
      streamifyResponse: (fn: unknown) => fn,
      HttpResponseStream: { from: (s: PassThrough, meta: { statusCode: number }) => (preludes.push(meta), s) },
    });
    const { handler } = await import("./stream-handler.js");
    const out = new PassThrough();
    let body = "";
    out.on("data", (c) => (body += c));
    await (handler as (e: unknown, s: PassThrough) => Promise<void>)({ rawPath: "/runs/r1/stream", queryStringParameters: { ticket: "t" }, headers: {} }, out);
    expect(preludes).toEqual([expect.objectContaining({ statusCode: 500 })]);
    expect(JSON.parse(body)).toEqual({ error: "The stream failed." });
  });
});
