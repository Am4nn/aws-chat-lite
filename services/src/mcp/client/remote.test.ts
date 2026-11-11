import http from "node:http";
import type { AddressInfo } from "node:net";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpTestServer } from "../testing/server.js";
import { guardedFetch } from "./fetch.js";
import { callRemoteTool, listRemoteTools, probe } from "./remote.js";

const f = guardedFetch({ localHosts: ["127.0.0.1"] });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(o?: Parameters<typeof startMcpTestServer>[0]) {
  const server = await startMcpTestServer(o);
  closers.push(() => server.close());
  return server;
}

/** An MCP server that lists the given tools over two pages, for the snapshot limits the test server can't show. */
async function serveTools(tools: Tool[]) {
  const half = Math.ceil(tools.length / 2);
  const listener = http.createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    const server = new Server({ name: "paged", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
      params?.cursor ? { tools: tools.slice(half) } : { tools: tools.slice(0, half), nextCursor: "2" },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  closers.push(() => {
    listener.closeAllConnections();
    return new Promise((r) => listener.close(() => r()));
  });
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
}

describe("probe", () => {
  it("finds OAuth from the 401", async () => {
    const server = await start();
    const probed = await probe(server.url, f);
    expect(probed).toMatchObject({ auth: "oauth", scope: "notes" });
    expect(probed.auth === "oauth" && probed.resourceMetadataUrl?.href).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
  });

  it("finds an open server", async () => {
    const server = await start({ auth: "none" });
    expect(await probe(server.url, f)).toEqual({ auth: "none" });
  });

  it("refuses something that isn't an MCP server", async () => {
    const server = await start({ auth: "none" });
    await expect(probe(`${server.origin}/nothing`, f)).rejects.toThrow("127.0.0.1 answered with status 404.");
  });
});

describe("listRemoteTools", () => {
  it("snapshots the tools with their read-only hints", async () => {
    const server = await start({ auth: "none" });
    const { tools, toolCount } = await listRemoteTools("test", server.url, undefined, f);
    expect(toolCount).toBe(4);
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([
      ["echo", true],
      ["add_note", false],
      ["whoami", true],
      ["fail", true],
    ]);
    expect(tools[0]).toEqual({
      name: "echo",
      description: "Repeats the text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      readOnly: true,
    });
  });

  it("keeps the first 40 tools", async () => {
    const server = await start({ auth: "none", extraTools: 41 });
    const { tools, toolCount } = await listRemoteTools("test", server.url, undefined, f);
    expect(toolCount).toBe(45);
    expect(tools).toHaveLength(40);
    expect(tools.at(-1)!.name).toBe("tool_36");
  });

  it("pages, cuts long descriptions and drops huge schemas", async () => {
    const url = await serveTools([
      { name: "long", title: "Long one", description: "d".repeat(1_500), inputSchema: { type: "object" } },
      { name: "huge", description: "big", inputSchema: { type: "object", properties: { x: { type: "string", description: "x".repeat(10_000) } } } },
      { name: "plain", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    ]);
    const { tools, toolCount } = await listRemoteTools("test", url, undefined, f);
    expect(toolCount).toBe(3);
    expect(tools).toEqual([
      { name: "long", description: `${"d".repeat(1_000)}\n…(cut)`, inputSchema: { type: "object" }, readOnly: false },
      { name: "plain", description: "", inputSchema: { type: "object" }, readOnly: false },
    ]);
  });

  it("drops names the MCP spec doesn't allow, so a remote name never reaches a card unchecked", async () => {
    const url = await serveTools([
      { name: "Run echo on test? Approve to", inputSchema: { type: "object" } },
      { name: "x".repeat(200), inputSchema: { type: "object" } },
      { name: "", inputSchema: { type: "object" } },
      { name: "get.user-2_x", inputSchema: { type: "object" } },
    ]);
    const { tools, toolCount } = await listRemoteTools("test", url, undefined, f);
    expect(toolCount).toBe(4);
    expect(tools.map((t) => t.name)).toEqual(["get.user-2_x"]);
  });

  it("keeps only the first tool per name the model sees, so a model call never carries the same name twice", async () => {
    const url = await serveTools([
      { name: "get.user", description: "first", inputSchema: { type: "object" } },
      { name: "get_user", description: "second", inputSchema: { type: "object" } },
      { name: "get.user", description: "repeated", inputSchema: { type: "object" } },
      { name: "other", inputSchema: { type: "object" } },
    ]);
    const { tools } = await listRemoteTools("test", url, undefined, f);
    expect(tools.map((t) => [t.name, t.description])).toEqual([["get.user", "first"], ["other", ""]]);
  });

  it("stops adding tools before the snapshot outgrows its table item", async () => {
    const big = (i: number): Tool => ({
      name: `tool_${i}`, description: "d".repeat(1_000),
      inputSchema: { type: "object", properties: { x: { type: "string", description: "x".repeat(9_500) } } },
    });
    const url = await serveTools(Array.from({ length: 40 }, (_, i) => big(i)));
    const { tools, toolCount } = await listRemoteTools("test", url, undefined, f);
    expect(toolCount).toBe(40);
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.length).toBeLessThan(40);
    expect(tools.map((t) => t.name)).toEqual(Array.from({ length: tools.length }, (_, i) => `tool_${i}`));
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(300_000);
  });

  it("surfaces a 401 as Unauthorized", async () => {
    const server = await start();
    await expect(listRemoteTools("test", server.url, "wrong", f)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("callRemoteTool", () => {
  it("returns the tool's text", async () => {
    const server = await start({ auth: "none" });
    expect(await callRemoteTool(server.url, undefined, "echo", { text: "hi" }, f)).toEqual({ ok: true, output: "echo: hi" });
    expect(server.calls).toEqual([{ tool: "echo", input: { text: "hi" }, sub: undefined }]);
  });

  it("returns a failed tool as not ok", async () => {
    const server = await start({ auth: "none" });
    expect(await callRemoteTool(server.url, undefined, "fail", {}, f)).toEqual({ ok: false, output: "it failed" });
  });

  it("rejects an unknown tool", async () => {
    const server = await start({ auth: "none" });
    await expect(callRemoteTool(server.url, undefined, "nope", {}, f)).rejects.toThrow("There's no tool called nope.");
  });

  it("surfaces a 401 as Unauthorized", async () => {
    const server = await start();
    await expect(callRemoteTool(server.url, "wrong", "echo", { text: "hi" }, f)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(server.calls).toEqual([]);
  });
});
