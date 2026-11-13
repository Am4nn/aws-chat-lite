import { mcpServerOf } from "../mcp/client/names.js";
import { modelInfo, type Provider } from "../models/catalog.js";
import { ASPECTS } from "../images/step.js";
import type { ToolCall, ToolSpec } from "../models/gateway.js";
import { isPrivate, mcpTaint, privateOf, type TaintSource } from "../models/privacy.js";
import { LANGUAGES, MAX_TIMEOUT_SEC } from "../sandbox/sandbox.js";
import type { Agent, ApprovalMode, ToolKind } from "../threads/types.js";
import { findTool, roomTools, type RoomMcp } from "../tools/index.js";
import type { Tool } from "../tools/types.js";

const FAKE_LOOKUP = "fake.lookup";

export const FAKE_TOOLS: ToolSpec[] = [
  {
    name: FAKE_LOOKUP,
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

const IMAGE_TOOL: ToolSpec = {
  name: "image_generate",
  description: "Generate an image from a text description, with Gemini. "
    + "It is saved to the room's files under images/ and shown in the thread. About $0.07 per image.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 2000 },
      aspect: { enum: [...ASPECTS] },
      name: { type: "string", description: "A few words to name the file by." },
    },
    required: ["prompt"],
  },
};

/**
 * The image tool as the approval gate sees it. Gemini may not see private content, and a prompt written in a private
 * thread could carry some there, so there it asks first, as a web call does.
 */
export const IMAGE_GATE = {
  spec: IMAGE_TOOL, kind: "images", write: false,
  ask: (input: Record<string, unknown>) => `Send "${String(input.prompt ?? "").slice(0, 80)}" to Gemini for an image?`,
} as const;

export const firstLine = (text: unknown) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export const DELEGATE = "delegate";
const DELEGATE_ABOUT = "Hand one sub-task to another agent of this room. It sees only the task you write, works with its own "
  + "tools and instructions, and its final answer comes back as this tool's result.";

/**
 * Another agent of the room as a run knows it: enough to pick it for a sub-task. The run's first step checkpoints
 * the room's other agents, and twenty full instructions would come near the checkpoint's size limit, so a helper's
 * whole agent is read when it starts.
 */
export type AgentCard = Pick<Agent, "agentId" | "name"> & { about: string };

export const agentCard = (a: Agent): AgentCard => ({ agentId: a.agentId, name: a.name, about: firstLine(a.instructions).slice(0, 120) });

/** The tool that hands a sub-task to one of `others`, the agents a run's agent can ask; none when there are none. */
export function delegateSpec(others: AgentCard[]): ToolSpec | undefined {
  if (!others.length) return undefined;
  const roster = others.map((a) => (a.about ? `@${a.name}: ${a.about}` : `@${a.name}`));
  return {
    name: DELEGATE,
    description: [DELEGATE_ABOUT, "Agents:", ...roster].join("\n"),
    inputSchema: {
      type: "object",
      properties: { agent: { enum: others.map((a) => a.name) }, task: { type: "string" } },
      required: ["agent", "task"],
    },
  };
}

/**
 * The tools a model is offered: those of the kinds its agent may use, plus the room memory, which every agent shares.
 * Sandbox output carries room files, so only a model that may see private content gets the sandbox; images go to any
 * model, since what comes back is only the file's path, never the image. The fake's tools are ones only the fake
 * accepts; GitHub's need the room to be connected, and an MCP server's a signed-in connection.
 */
export function toolsFor(model: string, served: Provider, room: RoomMcp & { github: boolean }, kinds: ToolKind[]): ToolSpec[] {
  const privateOk = modelInfo(model).privateOk;
  const allowed = (t: Tool) => t.kind === "memory" || kinds.includes(t.kind);
  return [
    ...(served === "fake" ? FAKE_TOOLS : []),
    ...(privateOk && kinds.includes("sandbox") ? [SANDBOX_TOOL] : []),
    ...(kinds.includes("images") ? [IMAGE_TOOL] : []),
    ...roomTools({ ...room, privateOk }).filter(allowed).map((t) => t.spec),
  ];
}

/**
 * Whether a call may run: a tool its model could be offered were every room connection signed in. A room's missing or
 * signed-out connection is left to the tool's own check, which tells the model so, rather than calling the tool unknown.
 */
export function mayRun(model: string, served: Provider, name: string, { roomId, mcp }: RoomMcp, kinds: ToolKind[]): boolean {
  const signedIn = mcp.map((c) => ({ ...c, status: "connected" as const }));
  return toolsFor(model, served, { roomId, github: true, mcp: signedIn }, kinds).some((t) => t.name === name);
}

/**
 * The sandbox as the approval gate sees it. Its file work stays in the room, but while the room lets it reach the
 * internet, code written after reading room chat could carry that chat out.
 */
export const SANDBOX_GATE = {
  spec: SANDBOX_TOOL, kind: "sandbox", write: false,
  ask: (input: Record<string, unknown>) => `Run ${String(input.language)} in the sandbox with internet access?`,
} as const;

/** The gate of a tool the run itself provides rather than the room's tools: the sandbox or images. */
export const runGate = (name: string) => [IMAGE_GATE, SANDBOX_GATE].find((g) => g.spec.name === name);

/** A tool as the approval gate weighs it. */
export type Gated = Pick<Tool, "spec" | "write" | "destructive"> & { kind: Tool["kind"] | "images" | "sandbox" };

/** Kinds whose input leaves the room: GitHub's too, since a search or a comment carries text to GitHub. */
const OUTBOUND = new Set<Gated["kind"]>(["web", "mcp", "images", "github"]);

/**
 * Whether a call waits for a member's approval. The floor asks in every mode: before a call that deletes, before
 * one whose input leaves the room once the thread read room chat, since text injected into that chat could have the
 * model carry it out, and before a post or an agent's setup from a thread holding private content: a channel's
 * messages are the background of any later thread there, and an agent's instructions are its prompt and the line other
 * agents read about it, whatever their models, so a member reads them first. Past the floor, Bypass asks nothing, and
 * Auto lets posts and agent setup run. Otherwise a write asks, and so does a web, MCP or image call once the thread
 * holds any private content but what this same MCP server returned itself. A GitHub read sends its input only to the
 * room's own repos, and memory stays in the room, so private content alone never makes them ask. `taint` is the
 * thread's, with whatever the model's turn saw that the stored taint may lag behind.
 */
export function asksFirst(tool: Gated, taint: TaintSource[], { mode, sandboxInternet }: { mode: ApprovalMode; sandboxInternet: boolean }): boolean {
  const leaves = OUTBOUND.has(tool.kind) || (tool.kind === "sandbox" && sandboxInternet);
  const roomWrite = tool.kind === "room_post" || tool.kind === "room_agents";
  if (tool.destructive || (leaves && taint.includes("room")) || (roomWrite && isPrivate(taint))) return true;
  if (mode === "bypass") return false;
  if (mode === "auto" && roomWrite) return false;
  if (tool.write) return true;
  if (tool.kind !== "web" && tool.kind !== "mcp" && tool.kind !== "images") return false;
  const own = tool.kind === "mcp" ? mcpTaint(mcpServerOf(tool.spec.name)) : undefined;
  return privateOf(taint).some((t) => t !== own);
}

/** The line a running step shows under its tool's name. */
export function toolDetail(call: ToolCall, room: RoomMcp): string {
  if (call.name === FAKE_LOOKUP) return `Looking up "${call.input.query}"`;
  if (call.name === SANDBOX_TOOL.name) return `Running ${call.input.language}: ${firstLine(call.input.code).slice(0, 60)}`;
  if (call.name === IMAGE_TOOL.name) return `Drawing "${String(call.input.prompt ?? "").slice(0, 60)}"`;
  return findTool(call.name, room)?.detail(call.input) ?? call.name;
}

export async function runFakeLookup(
  call: ToolCall,
  { sleep, signal }: { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal },
): Promise<{ output: string; ok: boolean }> {
  if (call.name !== FAKE_LOOKUP) return { ok: false, output: `Unknown tool ${call.name}.` };
  await sleep(call.input.slow ? 1500 : 200, signal);
  if (signal?.aborted) return { ok: false, output: "Stopped before the tool finished." };
  const notes = [1, 2, 3].map((n) => `- note ${n}: details about ${call.input.query}`);
  return { ok: true, output: [`Found 3 notes about "${call.input.query}".`, ...notes].join("\n") };
}
