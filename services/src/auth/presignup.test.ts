import { describe, it, expect, afterEach, vi } from "vitest";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import { handler } from "./presignup.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

const signUp = (userName: string) => ({ userName, response: {} }) as PreSignUpTriggerEvent;

/** The table, holding `count` agents named `name` across rooms. */
const agentsNamed = (name: string, count?: number) => vi.spyOn(docClient(), "send").mockImplementation((async (c: GetCommand) =>
  c.input.Key?.pk === `AGENTNAME#${name}` && count !== undefined ? { Item: { ...c.input.Key, agentCount: count } } : {}) as never);

afterEach(() => {
  delete process.env.STAGE;
  vi.restoreAllMocks();
});

describe("PreSignUp", () => {
  it("refuses the names mentions give a meaning to, in any case", async () => {
    agentsNamed("none");
    await expect(handler(signUp("everyone"))).rejects.toThrow("That username is reserved.");
    await expect(handler(signUp("Agent"))).rejects.toThrow("That username is reserved.");
    await expect(handler(signUp("schedule"))).rejects.toThrow("That username is reserved.");
  });

  it("refuses an agent's name, in any case, without saying it is an agent's", async () => {
    const send = agentsNamed("reviewer", 2);
    await expect(handler(signUp("Reviewer"))).rejects.toThrow(new Error("That username is taken."));
    expect((send.mock.calls[0]![0] as GetCommand).input).toMatchObject({ TableName: "t", Key: { pk: "AGENTNAME#reviewer", sk: "META" } });
  });

  it("accepts a name no agent has now, or ever had", async () => {
    agentsNamed("reviewer", 0);
    await expect(handler(signUp("reviewer"))).resolves.toMatchObject({ userName: "reviewer" });
    await expect(handler(signUp("ann"))).resolves.toMatchObject({ userName: "ann" });
  });

  it("confirms at once locally, where no email is sent", async () => {
    agentsNamed("none");
    process.env.STAGE = "local";
    expect((await handler(signUp("ann"))).response.autoConfirmUser).toBe(true);
  });

  it("leaves confirmation to the emailed code on AWS", async () => {
    agentsNamed("none");
    process.env.STAGE = "aws";
    expect((await handler(signUp("ann"))).response.autoConfirmUser).toBeUndefined();
  });
});
