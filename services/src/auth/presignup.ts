import type { PreSignUpTriggerEvent } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/db.js";
import { agentNameCountKey } from "../lib/keys.js";

/**
 * `@everyone` notifies the whole room, `@agent` calls the agent and `schedule` signs scheduled messages, so nobody may
 * sign up as any of them.
 */
const RESERVED = new Set(["everyone", "agent", "schedule"]);

/**
 * Cognito PreSignUp trigger. A thrown error refuses the sign-up, and Cognito hands its message to the caller. A name an
 * agent has in any room is refused too, so a mention never means a person and an agent; the refusal reads like any
 * taken name, without saying whose. Agent names are lowercase and mentions ignore case, hence the lowercased lookup.
 * Floci sends no email, so locally every new account is also confirmed at once.
 */
export async function handler(event: PreSignUpTriggerEvent) {
  const name = event.userName.toLowerCase();
  if (RESERVED.has(name)) throw new Error("That username is reserved.");
  const { Item } = await docClient().send(new GetCommand({ TableName: tableName(), Key: agentNameCountKey(name), ConsistentRead: true }));
  if ((Item?.agentCount ?? 0) > 0) throw new Error("That username is taken.");
  if (process.env.STAGE === "local") event.response.autoConfirmUser = true;
  return event;
}
