import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { docClient, tableName } from "../lib/db.js";

/**
 * Where to POST messages back to connected sockets. AWS: https://<domain>/<stage>.
 * Floci (it sets AWS_ENDPOINT_URL inside its Lambdas): the API's own host, <apiId>.execute-api.localhost.floci.io:4566
 * (its main endpoint answers "Unknown operation" to /@connections). WS_CALLBACK_URL overrides both.
 */
export function callbackEndpoint(
  ctx: { apiId: string; domainName: string; stage: string }, env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.WS_CALLBACK_URL) return env.WS_CALLBACK_URL;
  if (env.AWS_ENDPOINT_URL) return `http://${ctx.apiId}.execute-api.localhost.floci.io:4566/${ctx.stage}`;
  return `https://${ctx.domainName}/${ctx.stage}`;
}

/** Stores connections on $connect, forgets them on $disconnect, and echoes any other {"say": text} message to all of them. */
export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  const db = docClient();
  const TableName = tableName();
  const { routeKey, connectionId } = event.requestContext;
  if (routeKey === "$connect") {
    await db.send(new PutCommand({ TableName, Item: { pk: "CONN", sk: connectionId } }));
    return { statusCode: 200 };
  }
  if (routeKey === "$disconnect") {
    await db.send(new DeleteCommand({ TableName, Key: { pk: "CONN", sk: connectionId } }));
    return { statusCode: 200 };
  }
  const say = JSON.parse(event.body ?? "{}").say ?? "";
  const api = new ApiGatewayManagementApiClient({ endpoint: callbackEndpoint(event.requestContext) });
  const { Items = [] } = await db.send(new QueryCommand({
    TableName, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "CONN" },
  }));
  const Data = Buffer.from(JSON.stringify({ echo: say, from: connectionId }));
  await Promise.all(Items.map(async ({ sk }) => {
    try {
      await api.send(new PostToConnectionCommand({ ConnectionId: sk, Data }));
    } catch (e) {
      // A socket that closed without $disconnect answers Gone: forget it (the standard fan-out cleanup).
      if ((e as Error).name !== "GoneException") throw e;
      await db.send(new DeleteCommand({ TableName, Key: { pk: "CONN", sk } }));
    }
  }));
  return { statusCode: 200 };
}
