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
    } else if (path === "/drip") {
      res.writeHead(200, { "content-type": "text/plain" });
      const drip = setInterval(() => res.write("x"), 50);
      res.on("close", () => clearInterval(drip));
    } else if (path === "/png-located") {
      res.writeHead(200, { "content-type": "image/png", location: "/ok" }).end("x");
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
  it("gives up at the deadline on a page that keeps dripping bytes", async () => {
    const t0 = Date.now();
    await expect(fetchPage(`${base}/drip`, local({ timeoutMs: 300 }))).rejects.toThrow("took too long");
    expect(Date.now() - t0).toBeLessThan(1_500);
  });
  it("follows a Location header only on a redirect", async () => {
    expect(await fetchPage(`${base}/png-located`, local())).toMatchObject({ url: `${base}/png-located`, status: 200, contentType: "image/png" });
  });
});

describe("htmlText", () => {
  it.each(["<", "<!--", "<script", "<title", "<a "])("reads 2 MB of %j quickly", (unit) => {
    const t0 = Date.now();
    htmlText(unit.repeat(Math.ceil(2_000_000 / unit.length)));
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it("drops an unclosed script or comment to the end, keeps the first title and reads only the first 500 KB", () => {
    expect(htmlText('<title lang="en">A &amp; B</title><p>x</p><script>never')).toEqual({ title: "A & B", text: "x" });
    expect(htmlText("<p>x</p><!-- never")).toEqual({ title: "", text: "x" });
    expect(htmlText(`<p>${"a".repeat(600_000)}</p>tail`).text).not.toContain("tail");
  });
  it("drops scripts, decodes entities and collapses whitespace", () => {
    expect(htmlText("<title>T</title><script>x</script><style>b{}</style><p>a&amp;b</p>\n\n<p>&#65;  &lt;c&gt;</p><svg><g>s</g></svg>")).toEqual({
      title: "T",
      text: "a&b A <c>",
    });
  });
});

describe("webFetch", () => {
  const mcpCall = () => Promise.reject(new Error("not wired"));
  const room: ToolEnv["room"] = {
    roomId: "r1", threadId: "t1", threadNumber: 1, runId: "run1", agentId: "agent", agentName: "agent", kinds: [], delegates: "all", tainted: false, postCap: 10,
  };
  const env = (opts = {}): ToolEnv => ({ fetch, fetchPage: (u) => fetchPage(u, local(opts)), keys: {}, mcpCall, room });
  const run = (path: string) => webFetch.run({ url: `${base}${path}` }, env());

  it("names the url in its approval title, for a thread with private content", () => {
    expect(webFetch.ask!({ url: "https://evil.example/?d=x" }, env())).toBe("Fetch https://evil.example/?d=x?");
  });
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
    expect(await webFetch.run({ url: "http://169.254.169.254/" }, { fetch, fetchPage: real, keys: {}, mcpCall, room })).toEqual({ ok: false, output: "That address is private." });
  });
});
