import { modelInfo, type Provider } from "../models/catalog.js";
import type { ToolCall, ToolSpec } from "../models/gateway.js";
import { LANGUAGES, MAX_TIMEOUT_SEC } from "../sandbox/sandbox.js";
import { findTool, roomTools, type RoomMcp } from "../tools/index.js";

export const FAKE_TOOLS: ToolSpec[] = [
  {
    name: "fake.lookup",
    description: "Looks up notes about a query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

export const SANDBOX_TOOL: ToolSpec = {
  name: "sandbox_run",
  description: "Run a shell command, Python or JavaScript in this room's sandbox. The working directory holds the room's shared files: "
    + "what you create, change or delete there is saved for the room. The sandbox may have no internet access.",
  inputSchema: {
    type: "object",
    properties: {
      language: { enum: [...LANGUAGES] },
      code: { type: "string" },
      timeoutSec: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SEC },
    },
    required: ["language", "code"],
  },
};

/**
 * The tools a model is offered. Sandbox output carries room files, so only a model that may see private content gets
 * the sandbox; the fake's tools are ones only the fake accepts; GitHub's need the room to be connected, and an MCP
 * server's a signed-in connection.
 */
export function toolsFor(model: string, served: Provider, room: RoomMcp & { github: boolean }): ToolSpec[] {
  const privateOk = modelInfo(model).privateOk;
  return [
    ...(served === "fake" ? FAKE_TOOLS : []),
    ...(privateOk ? [SANDBOX_TOOL] : []),
    ...roomTools({ ...room, privateOk }).map((t) => t.spec),
  ];
}

/**
 * Whether a call may run: a tool its model could be offered were every room connection signed in. A room's missing or
 * signed-out connection is left to the tool's own check, which tells the model so, rather than calling the tool unknown.
 */
export function mayRun(model: string, served: Provider, name: string, { roomId, mcp }: RoomMcp): boolean {
  const signedIn = mcp.map((c) => ({ ...c, status: "connected" as const }));
  return toolsFor(model, served, { roomId, github: true, mcp: signedIn }).some((t) => t.name === name);
}

const firstLine = (code: unknown) => String(code ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The line a running step shows under its tool's name. */
export function toolDetail(call: ToolCall, room: RoomMcp): string {
  if (call.name === "fake.lookup") return `Looking up "${call.input.query}"`;
  if (call.name === SANDBOX_TOOL.name) return `Running ${call.input.language}: ${firstLine(call.input.code).slice(0, 60)}`;
  return findTool(call.name, room)?.detail(call.input) ?? call.name;
}

export async function runTool(
  call: ToolCall,
  { sleep, signal }: { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal },
): Promise<{ output: string; ok: boolean }> {
  if (call.name !== "fake.lookup") return { ok: false, output: `Unknown tool ${call.name}.` };
  await sleep(call.input.slow ? 1500 : 200, signal);
  if (signal?.aborted) return { ok: false, output: "Stopped before the tool finished." };
  const notes = [1, 2, 3].map((n) => `- note ${n}: details about ${call.input.query}`);
  return { ok: true, output: [`Found 3 notes about "${call.input.query}".`, ...notes].join("\n") };
}
