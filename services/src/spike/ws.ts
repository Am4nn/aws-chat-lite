import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from "@aws-sdk/client-apigatewaymanagementapi";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = () => process.env.TABLE_NAME!;

/**
 * Where to POST messages back to connected sockets. AWS: https://<domain>/<stage>.
 * Floci (AWS_ENDPOINT_URL set inside its Lambdas): its own endpoint, unless WS_CALLBACK_URL overrides.
 */
export function callbackEndpoint(domainName: string, stage: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.WS_CALLBACK_URL) return env.WS_CALLBACK_URL;
  if (env.AWS_ENDPOINT_URL) return `${env.AWS_ENDPOINT_URL.replace(/\/$/, "")}/${stage}`;
  return `https://${domainName}/${stage}`;
}

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  if (routeKey === "$connect") {
    await db.send(new PutCommand({ TableName: TABLE(), Item: { pk: "CONN", sk: connectionId } }));
    return { statusCode: 200 };
  }
  if (routeKey === "$disconnect") {
    await db.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: "CONN", sk: connectionId } }));
    return { statusCode: 200 };
  }
  // $default: {"say": "..."} → broadcast {"echo", "from"} to every connection
  const say = JSON.parse(event.body ?? "{}").say ?? "";
  const api = new ApiGatewayManagementApiClient({ endpoint: callbackEndpoint(domainName, stage) });
  const { Items = [] } = await db.send(new QueryCommand({
    TableName: TABLE(), KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "CONN" },
  }));
  const Data = Buffer.from(JSON.stringify({ echo: say, from: connectionId }));
  await Promise.all(Items.map(async ({ sk }) => {
    try {
      await api.send(new PostToConnectionCommand({ ConnectionId: sk, Data }));
    } catch (e) {
      // A socket that closed without $disconnect: forget it (the standard fan-out cleanup).
      if (e instanceof GoneException || (e as Error).name === "GoneException") {
        await db.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: "CONN", sk } }));
      } else throw e;
    }
  }));
  return { statusCode: 200 };
}
