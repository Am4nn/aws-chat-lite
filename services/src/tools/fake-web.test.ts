import { describe, expect, it } from "vitest";
import { fakePage, fakeWebFetch } from "./fake-web.js";

describe("fake web", () => {
  it("answers Tavily with two results on example.com", async () => {
    const body = (await (await fakeWebFetch("https://api.tavily.com/search", { method: "POST" })).json()) as { results: { url: string }[] };
    expect(body.results.map((r) => r.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
  });
  it("serves a canned page but still refuses private addresses", async () => {
    expect((await fakePage("https://example.com/x")).body).toContain("<title>Fake page</title>");
    await expect(fakePage("http://10.0.0.1/")).rejects.toThrow();
  });
});
