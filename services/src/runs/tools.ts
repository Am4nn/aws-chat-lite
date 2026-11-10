import type { ToolCall, ToolSpec } from "../models/gateway.js";

export const FAKE_TOOLS: ToolSpec[] = [
  {
    name: "fake.lookup",
    description: "Looks up notes about a query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

/** The line a running step shows under its tool's name. */
export const toolDetail = (call: ToolCall) =>
  call.name === "fake.lookup" ? `Looking up "${call.input.query}"` : call.name;

export async function runTool(
  call: ToolCall,
  { sleep }: { sleep: (ms: number) => Promise<void> },
): Promise<{ output: string; ok: boolean }> {
  if (call.name !== "fake.lookup") return { ok: false, output: `Unknown tool ${call.name}.` };
  await sleep(call.input.slow ? 1500 : 200);
  const notes = [1, 2, 3].map((n) => `- note ${n}: details about ${call.input.query}`);
  return { ok: true, output: [`Found 3 notes about "${call.input.query}".`, ...notes].join("\n") };
}
