import type { GitHubConnection } from "../threads/types.js";
import { fakeGitHubFetch, fakeKeys } from "./fake-github.js";
import { fakePage, fakeWebFetch } from "./fake-web.js";
import { GITHUB_TOOLS } from "./github/tools.js";
import { toolKeys } from "./keys.js";
import type { Tool, ToolEnv } from "./types.js";
import { fetchPage, webFetch } from "./web/fetch.js";
import { webSearch } from "./web/search.js";

const WEB_TOOLS = [webSearch, webFetch];
const ALL_TOOLS = [...WEB_TOOLS, ...GITHUB_TOOLS];

export const findTool = (name: string): Tool | undefined => ALL_TOOLS.find((t) => t.spec.name === name);

/** GitHub's tools need the room's connection and a model that may see private content: GitHub data taints the thread. */
export const roomTools = ({ connected, privateOk }: { connected: boolean; privateOk: boolean }): Tool[] =>
  connected && privateOk ? ALL_TOOLS : WEB_TOOLS;

const fakeFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith("https://api.github.com/") ? fakeGitHubFetch(input, init) : fakeWebFetch(input, init);
};

/** Fake mode answers as GitHub and Tavily and serves canned pages, so every real code path runs without the network. */
export async function toolEnv(mode = process.env.TOOL_MODE, github?: GitHubConnection): Promise<ToolEnv> {
  if (mode === "live") return { fetch, fetchPage, keys: await toolKeys(), github };
  return { fetch: fakeFetch, fetchPage: fakePage, keys: fakeKeys(), github };
}
