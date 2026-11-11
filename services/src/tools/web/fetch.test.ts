import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page, ToolEnv } from "../types.js";
import { fetchPage, htmlText, webFetch } from "./fetch.js";
import { guardedLookup } from "./guard.js";

let server: http.Server;
let base: string;
let port: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const chain = /^\/r(\d)$/.exec(path);
    if (chain) {
      res.writeHead(302, { location: Number(chain[1]) > 0 ? `/r${Number(chain[1]) - 1}` : "/ok" }).end();
    } else if (path === "/private") {
      res.writeHead(302, { location: "http://127.0.0.1:9001/" }).end();
    } else if (path === "/big") {
      res.writeHead(200, { "content-type": "text/plain" }).end(Buffer.alloc(3_000_000, "a"));
    } else if (path === "/png") {
      res.writeHead(200, { "content-type": "image/png" }).end("x");
    } else if (path === "/long") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<p>${"a".repeat(30_000)}</p>`);
    } else if (path === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" }).write("x");
    } else if (path === "/html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>T</title><script>x</script><p>a&amp;b</p>");
    } else {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = String((server.address() as AddressInfo).port);
  base = `http://test.local:${port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

// The test server is on loopback, so the guard is swapped for a lookup that points the name at it.
const toLoopback = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never;
const local = (extra = {}) => ({ lookup: toLoopback, ports: [port], ...extra });

describe("fetchPage", () => {
  it("fetches through the injected lookup", async () => {
    const page = await fetchPage(`${base}/ok`, local());
    expect(page).toMatchObject({ url: `${base}/ok`, status: 200, contentType: "text/plain", body: "ok" });
  });
  it("follows three redirects and refuses a fourth", async () => {
    expect((await fetchPage(`${base}/r2`, local())).url).toBe(`${base}/ok`);
    await expect(fetchPage(`${base}/r3`, local())).rejects.toThrow("Too many redirects.");
  });
  it("refuses a redirect to a private address", async () => {
    await expect(fetchPage(`${base}/private`, local())).rejects.toThrow("That address is private.");
  });
  it("refuses a public name whose DNS answers loopback", async () => {
    const rebinding = guardedLookup(toLoopback);
    await expect(fetchPage("http://evil.example/", { lookup: rebinding })).rejects.toThrow("evil.example points to a private address.");
  });
  it("refuses a body over 2 MB", async () => {
    await expect(fetchPage(`${base}/big`, local())).rejects.toThrow("The page is over 2 MB.");
  });
  it("gives up on a page that stalls", async () => {
    await expect(fetchPage(`${base}/slow`, local({ timeoutMs: 200 }))).rejects.toThrow("took too long");
  });
});

describe("htmlText", () => {
  it("drops scripts, decodes entities and collapses whitespace", () => {
    expect(htmlText("<title>T</title><script>x</script><style>b{}</style><p>a&amp;b</p>\n\n<p>&#65;  &lt;c&gt;</p><svg><g>s</g></svg>")).toEqual({
      title: "T",
      text: "a&b A <c>",
    });
  });
});

describe("webFetch", () => {
  const env = (opts = {}): ToolEnv => ({ fetch, fetchPage: (u) => fetchPage(u, local(opts)), keys: {} });
  const run = (path: string) => webFetch.run({ url: `${base}${path}` }, env());

  it("returns title, url and text, and cites the final url", async () => {
    expect(await run("/html")).toEqual({ ok: true, output: `T\n${base}/html\n\na&b`, sources: [{ title: "T", url: `${base}/html` }] });
  });
  it("cuts the output at 20,000 characters", async () => {
    const r = await run("/long");
    expect(r.output.endsWith("\n…(cut)")).toBe(true);
    expect(r.output.length).toBe(20_000 + "\n…(cut)".length);
  });
  it("reports a non-text page, a big page and a refused address as plain errors", async () => {
    expect(await run("/png")).toEqual({ ok: false, output: "Not a text page (image/png)." });
    expect(await run("/big")).toEqual({ ok: false, output: "The page is over 2 MB." });
    expect(await run("/r4")).toEqual({ ok: false, output: "Too many redirects." });
    const real = (u: string): Promise<Page> => fetchPage(u);
    expect(await webFetch.run({ url: "http://169.254.169.254/" }, { fetch, fetchPage: real, keys: {} })).toEqual({ ok: false, output: "That address is private." });
  });
});
