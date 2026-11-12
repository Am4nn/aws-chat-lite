import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../lib/db.js";
import { mcpRepo } from "./repo.js";
import { seal } from "./seal.js";
import type { StoredAuth } from "./types.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const KEY = Buffer.alloc(32, 7);
const auth = {
  issuer: "https://as.example", metadata: {}, client: { client_id: "c" }, tokens: { access_token: "at-1", token_type: "Bearer" }, expiresAt: 1,
} as unknown as StoredAuth;

function store(answer: (c: unknown) => unknown = () => ({})) {
  const send = vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => answer(c)) as never);
  const notify = vi.fn(async (_roomId: string) => {});
  const repo = mcpRepo({ fetch: vi.fn(), hosts: [], key: async () => KEY, notifyRoom: notify });
  return { send, notify, tokens: repo.tokenStore("r", "test") };
}

const conditionFailed = () => {
  throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
};

describe("a connection's token store", () => {
  it("loads the sealed tokens with their version", async () => {
    const { tokens, send } = store(() => ({ Item: { sealed: seal(KEY, JSON.stringify(auth), "r#test"), version: 3 } }));
    expect(await tokens.load()).toEqual({ auth, version: 3 });
    expect((send.mock.calls[0]![0] as GetCommand).input).toMatchObject({ Key: { pk: "ROOM#r", sk: "MCPAUTH#test" }, ConsistentRead: true });
  });

  it("reads tokens sealed for another room or connection as none", async () => {
    const { tokens } = store(() => ({ Item: { sealed: seal(KEY, JSON.stringify(auth), "other#test"), version: 1 } }));
    expect(await tokens.load()).toBeNull();
    const { tokens: missing } = store(() => ({}));
    expect(await missing.load()).toBeNull();
  });

  it("saves the next version only over the version it read, so a racing refresh can't be overwritten", async () => {
    const { tokens, send } = store();
    expect(await tokens.save(auth, 3)).toBe(true);
    const { input } = send.mock.calls[0]![0] as UpdateCommand;
    expect(input).toMatchObject({
      ConditionExpression: "#version = :read", ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":read": 3, ":next": 4 },
    });
    expect(String(input.ExpressionAttributeValues![":sealed"])).not.toContain("at-1");
    expect(await store(conditionFailed).tokens.save(auth, 3)).toBe(false);
  });

  it("marks the connection as needing a reconnect and tells the room, unless it was removed", async () => {
    const { tokens, send, notify } = store();
    await tokens.markNeedsAuth();
    expect((send.mock.calls[0]![0] as UpdateCommand).input).toMatchObject({
      Key: { pk: "ROOM#r", sk: "LINK#mcp#test" }, ExpressionAttributeValues: { ":status": "needs_auth" },
    });
    expect(notify).toHaveBeenCalledWith("r");
    const removed = store(conditionFailed);
    await removed.tokens.markNeedsAuth();
    expect(removed.notify).not.toHaveBeenCalled();
  });
});
