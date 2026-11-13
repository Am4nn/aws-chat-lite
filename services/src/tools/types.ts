import type { ToolSpec } from "../models/gateway.js";
import type { Delegates, GitHubConnection, Source, ToolKind } from "../threads/types.js";

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
  /**
   * The run and thread the call is made for, and the agent making it. `tainted`: the thread holds private content.
   * `postCap`: how many chat posts the room lets one run make.
   */
  room: {
    roomId: string; threadId: string; threadNumber: number; runId: string; agentId: string; agentName: string;
    kinds: ToolKind[]; delegates: Delegates; tainted: boolean; postCap: number;
  };
};

export type Tool = {
  spec: ToolSpec;
  kind: "github" | "mcp" | "memory" | "web" | "room_read" | "room_post" | "room_agents";
  write: boolean;
  /** Deletes something, so it asks first in every approval mode. */
  destructive?: boolean;
  /** The step row line. */
  detail(input: Record<string, unknown>): string;
  /** An error before any approval is asked, or null. */
  check?(input: Record<string, unknown>, env: ToolEnv): string | null | Promise<string | null>;
  /** The approval title, for a call that waits on one: in Ask every write, and a web call in a thread with private content. */
  ask?(input: Record<string, unknown>, env: ToolEnv): string;
  run(input: Record<string, unknown>, env: ToolEnv): Promise<ToolResult>;
};
