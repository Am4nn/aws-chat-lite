import { describe, expect, it } from "vitest";
import { fetchPage, webFetch } from "./fetch.js";
import { webSearch } from "./search.js";

// Opt-in and uses the free Tavily quota: REAL_TOOLS=1 npm -w services run test:live
describe.skipIf(!process.env.REAL_TOOLS)("web tools against the real internet", () => {
  const env = {
    fetch, fetchPage: (url: string) => fetchPage(url), keys: { tavilyKey: process.env.TAVILY_API_KEY },
    mcpCall: () => Promise.reject(new Error("not wired")),
  };

  it("searches through Tavily", async () => {
    const r = await webSearch.run({ query: "AWS Lambda durable functions" }, env);
    expect(r.ok, r.output).toBe(true);
    expect(r.sources!.length).toBeGreaterThan(0);
    console.log(`search: ${r.sources!.length} sources, first ${r.sources![0]!.url}`);
  });

  it("fetches a public page and refuses the metadata address", async () => {
    const r = await webFetch.run({ url: "https://example.com/" }, env);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain("Example Domain");
    expect((await webFetch.run({ url: "http://169.254.169.254/latest/meta-data/" }, env)).ok).toBe(false);
  });
});
