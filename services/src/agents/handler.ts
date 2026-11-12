import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { requireMember } from "../rooms/membership.js";
import { callerFromEvent } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { memoryRepo } from "../memory/repo.js";
import { schedulesRepo } from "../schedules/repo.js";
import { scheduleTrigger } from "../schedules/scheduler.js";
import { copyAgent } from "./copy.js";
import { availableKinds, requireOffered } from "./kinds.js";
import { agentModel, agentName, instructionsText, toolKinds } from "./model.js";
import { agentsRepo } from "./repo.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Trigger = Pick<ReturnType<typeof scheduleTrigger>, "remove">;

/**
 * A room's agents and its memory: one Lambda behind the HTTP API's JWT authorizer. Every route checks membership, the
 * repos check who may change what, and each write tells the room's open pages to refetch.
 */
export function makeHandler(trigger: Trigger) {
  const stage = process.env.STAGE ?? "";

  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const { roomId = "", agentId = "", memoryId = "" } = event.pathParameters ?? {};
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      const user = callerFromEvent(event);
      const agents = agentsRepo();
      const memory = memoryRepo();
      switch (event.routeKey) {
        case "GET /rooms/{roomId}/agents":
          await requireMember(roomId, user.userId);
          return json(200, { agents: await agents.list(roomId), kinds: await availableKinds(roomId) });
        case "POST /rooms/{roomId}/agents": {
          const input = {
            name: agentName(body.name), instructions: instructionsText(body.instructions), tools: toolKinds(body.tools),
            model: agentModel(body.model, stage),
          };
          await requireMember(roomId, user.userId, { writing: true });
          await requireOffered(roomId, input.tools);
          return json(201, { agent: await agents.create(user, roomId, input) });
        }
        case "PATCH /rooms/{roomId}/agents/{agentId}": {
          const patch = {
            ...(body.name !== undefined && { name: agentName(body.name) }),
            ...(body.instructions !== undefined && { instructions: instructionsText(body.instructions) }),
            ...(body.tools !== undefined && { tools: toolKinds(body.tools) }),
            ...(body.model !== undefined && { model: agentModel(body.model, stage) }),
          };
          if (patch.tools) {
            await requireMember(roomId, user.userId, { writing: true });
            await requireOffered(roomId, patch.tools, (await agents.byId(roomId, agentId))?.tools);
          }
          return json(200, { agent: await agents.update(user, roomId, agentId, patch) });
        }
        case "DELETE /rooms/{roomId}/agents/{agentId}": {
          await agents.remove(user, roomId, agentId);
          // A trigger left behind fires once, finds its schedule gone and deletes itself.
          for (const scheduleId of await schedulesRepo().removeForAgent(roomId, agentId)) {
            await bestEffort("schedule trigger delete", () => trigger.remove(scheduleId));
          }
          return { statusCode: 204 };
        }
        case "POST /rooms/{roomId}/agents/{agentId}/copy": {
          const toRoomId = typeof body.toRoomId === "string" ? body.toRoomId : "";
          return json(200, await copyAgent(user, { roomId, agentId }, toRoomId));
        }
        case "GET /rooms/{roomId}/memory":
          return json(200, { entries: await memory.list(user, roomId) });
        case "PATCH /rooms/{roomId}/memory/{memoryId}":
          return json(200, { entry: await memory.edit(user, roomId, memoryId, body.text) });
        case "DELETE /rooms/{roomId}/memory/{memoryId}":
          await memory.remove(user, roomId, memoryId);
          return { statusCode: 204 };
        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// Built on first use, so tests can import makeHandler without Scheduler configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(scheduleTrigger()))(event);
