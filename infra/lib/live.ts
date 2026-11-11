import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { CoreStack } from "./core-stack.js";

/** A route per client action rather than all on $default, so each gets its own metrics and can get its own throttle. */
const ACTIONS = ["send", "edit", "delete", "react", "typing", "read", "subscribe", "ping", "stop"];

/** The live socket: one WebSocket API whose every route goes to one Lambda, which routes again on the frame's action. */
export function addLive(stack: CoreStack) {
  // API Gateway waits at most 29 s for an integration, and a send keeps working after its ack (handing the message to
  // the agent), so the function gets all of that rather than the default 10 s.
  const liveFn = stack.addFunction("live", "live/handler.ts", { tableAccess: true }, { timeout: Duration.seconds(29) });
  const integration = new WebSocketLambdaIntegration("LiveIntegration", liveFn);
  const wsApi = new apigwv2.WebSocketApi(stack, "Ws", {
    apiName: `${stack.stageConfig.prefix}-ws`,
    routeSelectionExpression: "$request.body.action",
    connectRouteOptions: { integration },
    disconnectRouteOptions: { integration },
    defaultRouteOptions: { integration },
  });
  for (const action of ACTIONS) wsApi.addRoute(action, { integration });
  const stage = new apigwv2.WebSocketStage(stack, "WsStage", { webSocketApi: wsApi, stageName: "live", autoDeploy: true });
  return { wsApi, stage, liveFn };
}
