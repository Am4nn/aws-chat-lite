import { afterEach, describe, it, expect, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import { normalizeQuery, searchMessages, searchRoom } from "./search.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

describe("normalizeQuery", () => {
  it("trims and lowercases, to match the stored textLower", () => {
    expect(normalizeQuery(" Hi ")).toBe("hi");
  });

  it("needs at least 2 characters", () => {
    expect(() => normalizeQuery("a")).toThrow(ValidationError);
    expect(() => normalizeQuery(" a ")).toThrow(ValidationError);
    expect(() => normalizeQuery(undefined)).toThrow(ValidationError);
  });
});

describe("searchRoom", () => {
  it("searches a room of 40 threads at most 8 chats at a time, so one search can't flood the table", async () => {
    let inFlight = 0;
    let most = 0;
    vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
      if (c instanceof GetCommand) return { Item: { role: "member" } };
      const { ":p": pk, ":s": prefix } = (c as QueryCommand).input.ExpressionAttributeValues!;
      if (prefix === "CHAT#") return { Items: [{ chatId: "general" }] };
      if (prefix === "THREAD#") return { Items: Array.from({ length: 40 }, (_, i) => ({ threadId: `t${i}` })) };
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { Items: pk === "CHAT#t7" ? [{ pk, sk: "MSG#1", roomId: "r", chatId: "t7", seq: 1, text: "hello", attachments: [], createdAt: "2026-11-11" }] : [] };
    }) as never);
    const { results } = await searchRoom({ userId: "u1", username: "aman" }, "r", "hello");
    expect(results.map((m) => m.chatId)).toEqual(["t7"]);
    expect(most).toBe(8);
  });
});

describe("searchMessages", () => {
  const stored = { pk: "CHAT#c1", sk: "MSG#1", roomId: "r1", chatId: "c1", seq: 1, text: "deploy now", attachments: [], createdAt: "2026-11-13" };

  it("searches a room for its own agents without a member check", async () => {
    vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
      if (c instanceof GetCommand) return {};
      const { ":s": prefix } = (c as QueryCommand).input.ExpressionAttributeValues!;
      if (prefix === "CHAT#") return { Items: [{ chatId: "c1" }] };
      if (prefix === "THREAD#") return { Items: [] };
      return { Items: [stored] };
    }) as never);
    expect((await searchMessages("r1", "deploy")).results.map((m) => m.seq)).toEqual([1]);
    await expect(searchRoom({ userId: "u1", username: "aman" }, "r1", "deploy")).rejects.toBeInstanceOf(NotFound);
  });
});
