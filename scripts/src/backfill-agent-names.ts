/**
 * Fills in, once after the deploy that started keeping them, the two records that keep people's and agents' names
 * apart: a lowercased record of every account's username, which agents may not take, and each agent name's global
 * count, which sign-up refuses while above 0. `npm run backfill:agent-names` for Floci, `-- --stage=aws` for AWS with
 * your `ig` profile. Both are recomputed from scratch, so running it again changes nothing; it prints what it changed.
 */
import { fileURLToPath } from "node:url";
import { CognitoIdentityProviderClient, ListUsersCommand, type ListUsersCommandOutput } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { BUILT_IN } from "../../services/src/agents/model.js";
import { agentNameCountKey, usernameKey } from "../../services/src/lib/keys.js";
import { readOutputs } from "./cdk.js";
import { run } from "./cli.js";
import { useAwsEnv, useLocalEnv } from "./env.js";

const COUNT_PREFIX = "AGENTNAME#";
const USAGE = "usage: npm run backfill:agent-names [-- --stage=aws]";

/** Writes a username record for every account in the pool; returns how many. */
export async function backfillUsernames(cognito: CognitoIdentityProviderClient, UserPoolId: string, db: DynamoDBDocumentClient, TableName: string) {
  let written = 0;
  let PaginationToken: string | undefined;
  do {
    const page: ListUsersCommandOutput = await cognito.send(new ListUsersCommand({ UserPoolId, PaginationToken }));
    for (const { Username } of page.Users ?? []) {
      await db.send(new PutCommand({ TableName, Item: usernameKey(Username!) }));
      written++;
    }
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);
  return written;
}

/**
 * Sets each agent name's count to the number of live agents that have it, across rooms. A count is written only if it
 * still holds what the scan read: an agent made or deleted meanwhile has moved it, and that name is left for a rerun.
 */
export async function backfillAgentCounts(db: DynamoDBDocumentClient, TableName: string) {
  const live = new Map<string, number>();
  const stored = new Map<string, number>();
  let ExclusiveStartKey: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await db.send(new ScanCommand({
      TableName, ExclusiveStartKey, FilterExpression: "begins_with(sk, :agent) OR begins_with(pk, :count)",
      ExpressionAttributeValues: { ":agent": "AGENT#", ":count": COUNT_PREFIX },
    }));
    for (const item of page.Items ?? []) {
      const pk = String(item.pk);
      if (pk.startsWith(COUNT_PREFIX)) stored.set(pk.slice(COUNT_PREFIX.length), Number(item.agentCount));
      // The built-in @agent's name is reserved, so it is never counted.
      else if (String(item.sk).startsWith("AGENT#") && !item.deleted && item.agentId !== BUILT_IN.agentId) {
        live.set(item.name, (live.get(item.name) ?? 0) + 1);
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const changed: { name: string; from: number; to: number }[] = [];
  const raced: string[] = [];
  for (const name of new Set([...live.keys(), ...stored.keys()])) {
    const [read, to] = [stored.get(name), live.get(name) ?? 0];
    if ((read ?? 0) === to) continue;
    try {
      await db.send(new PutCommand({
        TableName, Item: { ...agentNameCountKey(name), agentCount: to },
        ...(read === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "agentCount = :read", ExpressionAttributeValues: { ":read": read } }),
      }));
      changed.push({ name, from: read ?? 0, to });
    } catch (e) {
      if ((e as Error).name !== "ConditionalCheckFailedException") throw e;
      raced.push(name);
    }
  }
  return { changed, raced };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--stage=aws")) throw new Error(USAGE);
  const stage = args.length ? "aws" : "local";
  if (stage === "aws") useAwsEnv(); else useLocalEnv();
  const { TableName, UserPoolId } = stage === "aws" ? readOutputs("cl-aws-core", "outputs-aws.json") : readOutputs("cl-local-core");
  if (!TableName || !UserPoolId) throw new Error(`No TableName or UserPoolId in the ${stage} outputs: deploy first.`);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  // Usernames first: from then on no new agent can take one, while the counts are being set.
  console.log(`${await backfillUsernames(new CognitoIdentityProviderClient({}), UserPoolId, db, TableName)} username record(s) written.`);
  const { changed, raced } = await backfillAgentCounts(db, TableName);
  for (const { name, from, to } of changed) console.log(`@${name}: ${from} → ${to}`);
  if (raced.length) console.log(`Changed during the run, so left alone: ${raced.map((n) => `@${n}`).join(", ")}. Run it again.`);
  console.log(`✅ ${changed.length} agent name count(s) changed in ${TableName} (${stage}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run(main);
