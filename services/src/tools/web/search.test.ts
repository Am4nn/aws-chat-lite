import { describe, expect, it } from "vitest";
import type { ToolEnv } from "../types.js";
import { webSearch } from "./search.js";

const env = (fetchImpl: typeof fetch, tavilyKey?: string): ToolEnv => ({
  fetch: fetchImpl,
  fetchPage: async () => {
    throw new Error("unused");
  },
  keys: { tavilyKey },
  mcpCall: () => Promise.reject(new Error("not wired")),
  room: { roomId: "r1", threadId: "t1", threadNumber: 1, runId: "run1", agentId: "agent", agentName: "agent", tainted: false, postCap: 10 },
});
const status = (code: number): typeof fetch => async () => new Response("no", { status: code });

describe("webSearch", () => {
  it("names the query in its approval title, for a thread with private content", () => {
    expect(webSearch.ask!({ query: "acme payroll" }, env(fetch))).toBe('Search the web for "acme payroll"?');
  });
  it("sends the key and query, and cites every result", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ results: [{ title: "A", url: "https://a.example/", content: "aa" }, { title: "B", url: "https://b.example/", content: "bb" }] });
    };
    const r = await webSearch.run({ query: "q" }, env(fake, "k"));
    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ query: "q", max_results: 5, search_depth: "basic" });
    expect(r.output).toBe("[1] A\nhttps://a.example/\naa\n\n[2] B\nhttps://b.example/\nbb");
    expect(r.sources).toEqual([{ title: "A", url: "https://a.example/" }, { title: "B", url: "https://b.example/" }]);
  });
  it("explains a refused key, a failure and a missing key", async () => {
    expect(await webSearch.run({ query: "q" }, env(status(401), "k"))).toEqual({ ok: false, output: "Web search isn't set up (Tavily refused the key)." });
    expect((await webSearch.run({ query: "q" }, env(status(500), "k"))).output).toBe("Web search failed (500).");
    expect((await webSearch.run({ query: "q" }, env(() => Promise.reject(new Error("k")), "k"))).output).toBe("Web search couldn't be reached.");
    expect(await webSearch.run({ query: "q" }, env(fetch, undefined))).toEqual({ ok: false, output: "Web search isn't set up here (no TAVILY_API_KEY)." });
  });
  it("checks the query before running", () => {
    expect(webSearch.check!({ query: " " }, env(fetch, "k"))).toBe("A query is required.");
    expect(webSearch.check!({ query: "x" }, env(fetch, "k"))).toBeNull();
  });
});
