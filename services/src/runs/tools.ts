import { modelInfo, type Provider } from "../models/catalog.js";
import type { ToolCall, ToolSpec } from "../models/gateway.js";
import { findTool, roomTools } from "../tools/index.js";

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
      language: { enum: ["shell", "python", "javascript"] },
      code: { type: "string" },
      timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
    },
    required: ["language", "code"],
  },
};

/**
 * The tools a model is offered. Sandbox output carries room files, so only a model that may see private content gets
 * the sandbox; the fake's tools are ones only the fake accepts; GitHub's need the room to be connected.
 */
export function toolsFor(model: string, served: Provider, connected: boolean): ToolSpec[] {
  const privateOk = modelInfo(model).privateOk;
  return [
    ...(served === "fake" ? FAKE_TOOLS : []),
    ...(privateOk ? [SANDBOX_TOOL] : []),
    ...roomTools({ connected, privateOk }).map((t) => t.spec),
  ];
}

/**
 * Whether a call may run: a tool its model could be offered. A room's missing connection is left to the tool's own
 * check, which tells the model so, rather than calling the tool unknown.
 */
export const mayRun = (model: string, served: Provider, name: string) => toolsFor(model, served, true).some((t) => t.name === name);

const firstLine = (code: unknown) => String(code ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The line a running step shows under its tool's name. */
export function toolDetail(call: ToolCall): string {
  if (call.name === "fake.lookup") return `Looking up "${call.input.query}"`;
  if (call.name === SANDBOX_TOOL.name) return `Running ${call.input.language}: ${firstLine(call.input.code).slice(0, 60)}`;
  return findTool(call.name)?.detail(call.input) ?? call.name;
}

export async function runTool(
  call: ToolCall,
  { sleep }: { sleep: (ms: number) => Promise<void> },
): Promise<{ output: string; ok: boolean }> {
  if (call.name !== "fake.lookup") return { ok: false, output: `Unknown tool ${call.name}.` };
  await sleep(call.input.slow ? 1500 : 200);
  const notes = [1, 2, 3].map((n) => `- note ${n}: details about ${call.input.query}`);
  return { ok: true, output: [`Found 3 notes about "${call.input.query}".`, ...notes].join("\n") };
}
