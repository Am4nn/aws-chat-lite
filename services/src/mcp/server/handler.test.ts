import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Scope } from "../../threads/types.js";
import { makeMcpHandler } from "./handler.js";
import type { ServerDeps } from "./tools.js";

process.env.MCP_BASE_URL = "https://chat.example";

const SITE = "https://site.example";
const CHALLENGE = 'Bearer resource_metadata="https://chat.example/.well-known/oauth-protected-resource/mcp", scope="rooms:read rooms:write"';
const user = { userId: "u1", username: "aman" };

function setup(scopes: Scope[] = ["rooms:read", "rooms:write"]) {
  const verify = vi.fn(async (token: string) => (token === "good" ? { user, scopes, grantId: "g1" } : null));
  const deps = {
    rooms: { listMyRooms: vi.fn(async () => [{ roomId: "r1", name: "Dev", role: "owner" }]), getRoomView: vi.fn() },
    history: vi.fn(), send: vi.fn(), broadcast: vi.fn(), startThread: vi.fn(), siteUrl: SITE,
  } as unknown as ServerDeps;
  return { verify, deps, handle: makeMcpHandler(verify, deps) };
}

let id = 0;
const event = (rpc: object | null, { method = "POST", headers = {} }: { method?: string; headers?: Record<string, string> } = {}) => ({
  routeKey: `${method} /mcp`, rawPath: "/mcp", rawQueryString: "", isBase64Encoded: false,
  requestContext: { http: { method, sourceIp: "1.2.3.4" } },
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer good", ...headers },
  ...(rpc && { body: JSON.stringify({ jsonrpc: "2.0", id: ++id, ...rpc }) }),
}) as unknown as APIGatewayProxyEventV2;

const resultOf = (res: { body?: string }) => JSON.parse(res.body ?? "").result;
const call = (name: string, args: object = {}) => event({ method: "tools/call", params: { name, arguments: args } });

describe("the /mcp endpoint", () => {
  it("is stateless, so GET (an SSE stream) and DELETE (ending a session) are 405", async () => {
    const { handle } = setup();
    for (const method of ["GET", "DELETE"]) {
      expect(await handle(event(null, { method }))).toMatchObject({ statusCode: 405, headers: { allow: "POST" } });
    }
  });

  it("refuses a browser on another site, before any token is read", async () => {
    const { handle, verify } = setup();
    expect((await handle(event({ method: "tools/list" }, { headers: { origin: "https://evil.example" } }))).statusCode).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect((await handle(event({ method: "tools/list" }, { headers: { origin: SITE } }))).statusCode).toBe(200);
  });

  it("without a token, answers 401 with where to sign in", async () => {
    const { handle } = setup();
    const res = await handle(event({ method: "tools/list" }, { headers: { authorization: "" } }));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["www-authenticate"]).toBe(CHALLENGE);
  });

  it("with a token that doesn't check out, says it's invalid", async () => {
    const { handle } = setup();
    const res = await handle(event({ method: "tools/list" }, { headers: { authorization: "Bearer stale" } }));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["www-authenticate"]).toBe(`${CHALLENGE}, error="invalid_token"`);
  });

  it("introduces itself on initialize", async () => {
    const { handle } = setup();
    const res = await handle(event({
      method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }));
    expect(resultOf(res)).toMatchObject({
      serverInfo: { name: "chat-lite", version: "1.0.0" }, capabilities: { tools: {} },
      instructions: "chat-lite rooms: people chats and agent threads. Messages you post appear under your own name.",
    });
  });

  it("lists only the tools the token's scopes allow, without the scope itself", async () => {
    const { handle } = setup(["rooms:read"]);
    const { tools } = resultOf(await handle(event({ method: "tools/list" })));
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["list_rooms", "list_room", "read_messages"]);
    expect(Object.keys(tools[0]).sort()).toEqual(["annotations", "description", "inputSchema", "name", "title"]);
  });

  it("a read-only token calling a write tool gets an error result, and nothing runs", async () => {
    const { handle, deps } = setup(["rooms:read"]);
    const result = resultOf(await handle(call("post_message", { room: "Dev", chat: "general", text: "hi" })));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "This app can't use post_message." }] });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("runs a tool as the token's user", async () => {
    const { handle, deps } = setup();
    const result = resultOf(await handle(call("list_rooms")));
    expect(result).toEqual({ content: [{ type: "text", text: "Dev · owner · id r1" }] });
    expect(deps.rooms.listMyRooms).toHaveBeenCalledWith("u1");
  });

  it("a tool's refusal comes back as an error result in its own words", async () => {
    const { handle } = setup();
    const result = resultOf(await handle(call("list_room", { room: "Nope" })));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^No room/);
  });

  it("any other failure comes back as the default line, logged, never in its own words", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handle, deps } = setup();
    const denied = new Error("User: arn:aws:sts::123456789012:assumed-role/cl-role/fn is not authorized to perform: dynamodb:Query");
    vi.mocked(deps.rooms.listMyRooms).mockRejectedValueOnce(denied);
    const result = resultOf(await handle(call("list_rooms")));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Something went wrong." }] });
    expect(logged.mock.calls.flat()).toContain(denied);
    logged.mockRestore();
  });
});
