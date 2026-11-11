import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolEnv } from "../../tools/types.js";
import type { McpConnection } from "../../threads/types.js";
import { startMcpTestServer } from "../testing/server.js";
import { guardedFetch } from "./fetch.js";
import { completeAuthorization, beginAuthorization } from "./oauth.js";
import { listRemoteTools, probe } from "./remote.js";
import { mcpCaller, mcpServerOf, mcpTool, mcpToolName } from "./tools.js";
import type { StoredAuth, TokenStore } from "./types.js";

const echo = { name: "echo", description: "Repeats the text.", inputSchema: { type: "object" }, readOnly: true };
const addNote = { name: "add_note", description: "Saves a note.", inputSchema: { type: "object" }, readOnly: false };

const testConnection = (o: Partial<McpConnection> = {}): McpConnection => ({
  name: "test", url: "http://127.0.0.1:4710/mcp", auth: "oauth", status: "connected", tools: [echo, addNote], toolCount: 2,
  toolsAt: "2026-11-11T00:00:00Z", addedBy: "aman", addedAt: "2026-11-11T00:00:00Z", ...o,
});

describe("mcpToolName", () => {
  it("prefixes the server's name and keeps only characters a model's tool name may hold", () => {
    expect(mcpToolName("test", "add note!")).toBe("mcp__test__add_note_");
    expect(mcpToolName("my-server", "get-issue_2")).toBe("mcp__my-server__get-issue_2");
  });

  it("cuts a name over 64 characters and ends it with a hash of the tool's own name", () => {
    const long = "x".repeat(70);
    const name = mcpToolName("test", long);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^mcp__test__x+_[0-9a-f]{8}$/);
    expect(mcpToolName("test", `${"x".repeat(69)}y`)).not.toBe(name);
  });

  it("names the server back from a tool name, a cut one included", () => {
    expect(mcpServerOf(mcpToolName("my-server", "add__note"))).toBe("my-server");
    expect(mcpServerOf(mcpToolName("test", "x".repeat(70)))).toBe("test");
  });
});

describe("mcpTool", () => {
  const env = {} as ToolEnv;

  it("describes the tool with its server, and asks first only for one not marked read-only", () => {
    const read = mcpTool("r1", testConnection(), echo);
    expect(read).toMatchObject({ kind: "mcp", write: false, spec: { name: "mcp__test__echo", description: "test (MCP): Repeats the text." } });
    expect(read.spec.inputSchema).toEqual({ type: "object" });
    const write = mcpTool("r1", testConnection(), addNote);
    expect(write.write).toBe(true);
    expect(write.ask!({}, env)).toBe("Run add_note on test?");
    expect(write.detail({ text: "x" })).toBe("test · add_note");
  });

  it("refuses a call when the server needs reconnecting, or when the input isn't an object", () => {
    expect(mcpTool("r1", testConnection(), echo).check!({ text: "hi" }, env)).toBeNull();
    expect(mcpTool("r1", testConnection({ status: "needs_auth" }), echo).check!({}, env))
      .toBe("test needs reconnecting. An admin can reconnect it in the room panel.");
    expect(mcpTool("r1", testConnection(), echo).check!(["hi"] as unknown as Record<string, unknown>, env)).toBe("Give echo an object.");
  });

  it("runs through the env's MCP call, on the room's connection", async () => {
    const mcpCall = vi.fn(async () => ({ ok: true, output: "echo: hi" }));
    const result = await mcpTool("r1", testConnection(), echo).run({ text: "hi" }, { mcpCall } as unknown as ToolEnv);
    expect(result).toEqual({ ok: true, output: "echo: hi" });
    expect(mcpCall).toHaveBeenCalledWith({ roomId: "r1", name: "test" }, "echo", { text: "hi" });
  });
});

describe("mcpCaller", () => {
  const servers: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const f = guardedFetch({ localHosts: ["127.0.0.1"] });

  /** A room connected to a fresh test server, as the table would hold it. */
  async function connected(o: Parameters<typeof startMcpTestServer>[0] = {}) {
    vi.stubEnv("MCP_LOCAL_HOSTS", "127.0.0.1");
    const server = await startMcpTestServer(o);
    servers.push(server);
    let auth: StoredAuth | null = null;
    if (o.auth !== "none") {
      const probed = await probe(server.url, f);
      if (probed.auth !== "oauth") throw new Error("The test server should want OAuth.");
      const { authorizeUrl, pending } = await beginAuthorization({ url: server.url, redirectUri: "http://localhost:3000/cb", probed }, f, ["127.0.0.1"]);
      const code = new URL((await f(authorizeUrl)).headers.get("location")!).searchParams.get("code")!;
      auth = await completeAuthorization(pending, code, f);
    }
    const bearer = auth?.tokens.access_token;
    const { tools, toolCount } = await listRemoteTools(server.url, bearer, f);
    const conn = testConnection({ url: server.url, auth: o.auth ?? "oauth", tools, toolCount });
    const store: TokenStore = {
      load: async () => auth && { auth, version: 1 },
      save: async () => false,
      markNeedsAuth: vi.fn(async () => {}),
    };
    const call = mcpCaller(() => ({ get: async (_roomId, name) => (name === "test" ? conn : null), tokenStore: () => store }));
    return { server, call, store };
  }

  it("calls the tool with the room's token", async () => {
    const { server, call } = await connected();
    expect(await call({ roomId: "r1", name: "test" }, "echo", { text: "hi" })).toEqual({ ok: true, output: "echo: hi" });
    expect(server.calls).toEqual([{ tool: "echo", input: { text: "hi" }, sub: "tester" }]);
  });

  it("calls a server that wants no sign-in without a token", async () => {
    const { server, call } = await connected({ auth: "none" });
    expect(await call({ roomId: "r1", name: "test" }, "echo", { text: "hi" })).toEqual({ ok: true, output: "echo: hi" });
    expect(server.calls[0].sub).toBeUndefined();
  });

  it("tells the model to have an admin reconnect once the sign-in is gone", async () => {
    const { server, call, store } = await connected();
    server.revokeAll();
    expect(await call({ roomId: "r1", name: "test" }, "echo", { text: "hi" })).toEqual({
      ok: false, output: "test needs reconnecting. An admin can reconnect it in the room panel.",
    });
    expect(store.markNeedsAuth).toHaveBeenCalledOnce();
  });

  it("passes on a failed tool's own output, and names the server when it can't answer", async () => {
    const { call } = await connected();
    expect(await call({ roomId: "r1", name: "test" }, "fail", {})).toEqual({ ok: false, output: "it failed" });
    const unknown = await call({ roomId: "r1", name: "test" }, "nope", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toMatch(/^test didn't answer: .*There's no tool called nope\.$/);
  });

  it("says when the room no longer has the server", async () => {
    const { call } = await connected();
    expect(await call({ roomId: "r1", name: "gone" }, "echo", {})).toEqual({ ok: false, output: "This room has no MCP server called gone." });
  });
});
