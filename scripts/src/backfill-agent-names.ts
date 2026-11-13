/**
 * Sets every agent name's global count (how many live agents have it, across rooms, which sign-up refuses while above
 * 0) from the agents themselves. Run it once after the deploy that started counting: `npm run backfill:agent-names`
 * for Floci, `-- --stage=aws` for AWS with your `ig` profile. It recomputes every count, so running it again changes
 * nothing, and it prints each count it changed.
 */
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { BUILT_IN } from "../../services/src/agents/model.js";
import { agentNameCountKey } from "../../services/src/lib/keys.js";
import { run } from "./cli.js";
import { useAwsEnv, useLocalEnv } from "./env.js";

const COUNT_PREFIX = "AGENTNAME#";
const USAGE = "usage: npm run backfill:agent-names [-- --stage=aws]";

export async function backfillAgentNames(db: DynamoDBDocumentClient, TableName: string) {
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

  const changes = [...new Set([...live.keys(), ...stored.keys()])]
    .map((name) => ({ name, from: stored.get(name) ?? 0, to: live.get(name) ?? 0 }))
    .filter(({ from, to }) => from !== to);
  for (const { name, to } of changes) {
    await db.send(new PutCommand({ TableName, Item: { ...agentNameCountKey(name), agentCount: to } }));
  }
  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--stage=aws")) throw new Error(USAGE);
  const stage = args.length ? "aws" : "local";
  if (stage === "aws") useAwsEnv(); else useLocalEnv();
  // The table's name is fixed per stage, so a deploy by the pipeline, which writes no outputs file here, is enough.
  const TableName = `cl-${stage}-main`;
  const changes = await backfillAgentNames(DynamoDBDocumentClient.from(new DynamoDBClient({})), TableName);
  for (const { name, from, to } of changes) console.log(`@${name}: ${from} → ${to}`);
  console.log(`✅ ${changes.length} agent name count(s) changed in ${TableName} (${stage}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run(main);
