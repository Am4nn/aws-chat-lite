import type { ToolSpec } from "../models/gateway.js";
import type { GitHubConnection, Source } from "../threads/types.js";

export type ToolKeys = {
  tavilyKey?: string; githubAppId?: string; githubAppSlug?: string; githubPrivateKey?: string; githubClientId?: string; githubClientSecret?: string;
};
export type Page = { url: string; status: number; contentType: string; body: string };
export type ToolResult = { ok: boolean; output: string; sources?: Source[] };
export type ToolEnv = {
  fetch: typeof fetch;
  fetchPage: (url: string) => Promise<Page>;
  keys: ToolKeys;
  github?: GitHubConnection;
  mcpCall: (target: { roomId: string; name: string }, tool: string, input: Record<string, unknown>) => Promise<ToolResult>;
  /** The thread the call is made for. `tainted`: it holds private content. */
  room: { roomId: string; threadNumber: number; agentName: string; tainted: boolean };
};

export type Tool = {
  spec: ToolSpec;
  kind: "github" | "mcp" | "memory" | "web";
  write: boolean;
  /** The step row line. */
  detail(input: Record<string, unknown>): string;
  /** An error before any approval is asked, or null. */
  check?(input: Record<string, unknown>, env: ToolEnv): string | null;
  /** The approval title, for a call that waits on one: every write, and a web call in a thread with private content. */
  ask?(input: Record<string, unknown>, env: ToolEnv): string;
  run(input: Record<string, unknown>, env: ToolEnv): Promise<ToolResult>;
};
