import type { Page } from "./types.js";
import { checkUrl } from "./web/guard.js";

/** Stands in for `fetch` in tests and local runs: Tavily answers with two canned results, anything else is a 404. */
export const fakeWebFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.tavily.com/search")) return new Response("not found", { status: 404 });
  const results = [1, 2].map((n) => ({ title: `Example result ${n}`, url: `https://example.com/${n}`, content: `Snippet ${n}.` }));
  return Response.json({ results });
};

/** Stands in for `fetchPage`: the real address checks still run, but nothing touches the network. */
export async function fakePage(raw: string): Promise<Page> {
  const url = checkUrl(raw);
  return { url: url.href, status: 200, contentType: "text/html", body: "<title>Fake page</title><p>Fake page text.</p>" };
}
