import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guardedFetch } from "./fetch.js";

let server: http.Server;
let base: string;
let port: number;
let connections = 0;
const received: { method?: string; authorization?: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({ method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url === "/redirect") return res.writeHead(302, { location: "http://127.0.0.1/" }).end();
    if (req.url === "/big") return res.end(Buffer.alloc(3_000_000, "a"));
    if (req.url === "/silent") return;
    if (req.url === "/weird") return res.writeHead(999).end();
    if (req.url === "/none") return res.writeHead(204).end();
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.write("data: first\n\n");
    }
    res.writeHead(200, { "content-type": "application/json", "x-two": "a" }).end('{"ok":true}');
  });
  server.on("connection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const local = guardedFetch({ localHosts: ["127.0.0.1"] });

describe("guardedFetch refusals (no request made)", () => {
  it.each([
    ["http://169.254.169.254/", "Use an https URL."],
    ["https://10.0.0.1/", "That address is private."],
    ["http://example.com/", "Use an https URL."],
    ["https://u:p@x.com/", "Links with a username or password aren't allowed."],
  ])("%s", async (url, message) => {
    const lookup = vi.fn();
    await expect(guardedFetch({ lookup: lookup as never })(url)).rejects.toThrow(message);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address", async () => {
    const before = connections;
    const lookup = ((_host: string, _o: object, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;
    await expect(guardedFetch({ lookup })(`https://evil.example:${port}/`)).rejects.toThrow(
      "evil.example points to a private address.",
    );
    expect(connections).toBe(before);
  });
});

describe("guardedFetch answers", () => {
  it("resolves a local host with the given lookup, unchecked", async () => {
    const lookup = vi.fn(((_host: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
      o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never);
    const res = await guardedFetch({ localHosts: ["host.docker.internal"], lookup })(`http://host.docker.internal:${port}/`);
    expect(await res.json()).toEqual({ ok: true });
    expect(lookup).toHaveBeenCalled();
  });

  it("hands a redirect back instead of following it", async () => {
    const res = await local(`${base}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1/");
  });

  it("errors past 2 MB", async () => {
    const res = await local(`${base}/big`);
    await expect(res.text()).rejects.toThrow("The server's answer is over 2 MB.");
  });

  it("streams, so an SSE event is readable before the server ends", async () => {
    const res = await local(`${base}/sse`);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await reader.cancel();
  });

  it("sends the method, headers and body intact", async () => {
    const res = await local(`${base}/post`, {
      method: "POST",
      headers: new Headers({ authorization: "Bearer abc" }),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r 1" }),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-two")).toBe("a");
    expect(received.at(-1)).toEqual({ method: "POST", authorization: "Bearer abc", body: "grant_type=refresh_token&refresh_token=r+1" });
  });

  it("refuses a status a Response can't hold", async () => {
    await expect(local(`${base}/weird`)).rejects.toThrow("127.0.0.1 answered with status 999.");
  });

  it("gives a bodiless answer a null body", async () => {
    const res = await local(`${base}/none`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("gives up on a silent server", async () => {
    await expect(guardedFetch({ localHosts: ["127.0.0.1"], timeoutMs: 50 })(`${base}/silent`)).rejects.toThrow(
      "127.0.0.1 took too long to answer.",
    );
  });

  it("keeps the deadline while the answer streams", async () => {
    const res = await guardedFetch({ localHosts: ["127.0.0.1"], timeoutMs: 100 })(`${base}/sse`);
    await expect(res.text()).rejects.toThrow("127.0.0.1 took too long to answer.");
  });

  it("honours the caller's signal", async () => {
    await expect(local(`${base}/silent`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
  });
});
