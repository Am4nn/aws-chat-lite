import type { Tool } from "../types.js";
import { cut } from "./fetch.js";

type TavilyResult = { title: string; url: string; content: string };

export const webSearch: Tool = {
  spec: {
    name: "web_search",
    description: "Searches the web and returns the top results with a short snippet each. Cite the sources you use.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  kind: "web",
  write: false,
  detail: (input) => String(input.query ?? ""),
  check: (input) => (typeof input.query === "string" && input.query.trim() ? null : "A query is required."),
  async run(input, env) {
    const key = env.keys.tavilyKey;
    if (!key) return { ok: false, output: "Web search isn't set up here (no TAVILY_API_KEY)." };
    let res: Response;
    try {
      res = await env.fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ query: String(input.query), max_results: 5, search_depth: "basic" }),
      });
    } catch {
      return { ok: false, output: "Web search couldn't be reached." };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, output: "Web search isn't set up (Tavily refused the key)." };
    if (!res.ok) return { ok: false, output: `Web search failed (${res.status}).` };
    const { results = [] } = (await res.json()) as { results?: TavilyResult[] };
    const sources = results.map((r) => ({ title: r.title, url: r.url }));
    const output = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join("\n\n");
    return { ok: true, output: cut(output || "No results."), sources };
  },
};
