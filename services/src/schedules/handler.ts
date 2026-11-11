import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { Unavailable } from "../lib/errors.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { roomUpdated } from "../live/broadcast.js";
import type { Schedule } from "../threads/types.js";
import { schedulesRepo } from "./repo.js";
import { scheduleTrigger } from "./scheduler.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Trigger = Pick<ReturnType<typeof scheduleTrigger>, "put" | "remove">;

/**
 * A room's schedules and time zone: one Lambda behind the HTTP API's JWT authorizer. The schedule item is written
 * first and is the truth; EventBridge Scheduler then gets a trigger for each enabled one. A trigger left behind by a
 * failed delete fires once, finds nothing to run and deletes itself, so removals are best effort.
 */
export function makeHandler(trigger: Trigger, notifyRoom: (roomId: string) => Promise<unknown>) {
  /** A schedule shown as on must have a trigger, so one Scheduler refuses goes back off. */
  async function arm(roomId: string, schedule: Schedule, tz: string) {
    try {
      await trigger.put(roomId, schedule, tz);
    } catch (e) {
      console.error("schedule trigger put failed", schedule.scheduleId, e);
      await schedulesRepo().setEnabled(roomId, schedule.scheduleId, false);
      throw new Unavailable("Couldn't turn the schedule on; try again.");
    }
  }
  const disarm = (scheduleId: string) => bestEffort("schedule trigger delete", () => trigger.remove(scheduleId));

  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const { roomId = "", scheduleId = "" } = event.pathParameters ?? {};
    const parsed = parseBody(event);
    if (parsed === null) return json(400, { error: "Body must be JSON." });
    const body = parsed as Record<string, unknown>;
    try {
      const user = callerFromEvent(event);
      const repo = schedulesRepo();
      switch (event.routeKey) {
        case "GET /rooms/{roomId}/schedules":
          return json(200, await repo.list(user, roomId));
        case "POST /rooms/{roomId}/schedules": {
          const { agentId, title, prompt, cadence, chatId } = body;
          const schedule = await repo.create(user, roomId, { agentId, title, prompt, cadence, chatId });
          await arm(roomId, schedule, await repo.timeZoneOf(roomId));
          return json(201, { schedule });
        }
        case "PATCH /rooms/{roomId}/schedules/{scheduleId}": {
          const { title, prompt, cadence, chatId, enabled } = body;
          const schedule = await repo.update(user, roomId, scheduleId, { title, prompt, cadence, chatId, enabled });
          // The trigger carries only the cadence and the zone, so other edits leave it as it is.
          if (cadence !== undefined || enabled !== undefined) {
            if (schedule.enabled) await arm(roomId, schedule, await repo.timeZoneOf(roomId));
            else await disarm(scheduleId);
          }
          return json(200, { schedule });
        }
        case "DELETE /rooms/{roomId}/schedules/{scheduleId}":
          await repo.remove(user, roomId, scheduleId);
          await disarm(scheduleId);
          return { statusCode: 204 };
        case "PUT /rooms/{roomId}/timezone": {
          const timeZone = await repo.setTimeZone(user, roomId, body.timeZone);
          await bestEffort("room.updated broadcast", () => notifyRoom(roomId));
          const enabled = (await repo.list(user, roomId)).schedules.filter((s) => s.enabled);
          // Every trigger gets its try; a refused one is switched off and reported.
          const refused = (await Promise.allSettled(enabled.map((s) => arm(roomId, s, timeZone)))).find((r) => r.status === "rejected");
          if (refused) throw refused.reason;
          return json(200, { timeZone });
        }
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
export const handler = (event: Event) => (liveHandler ??= makeHandler(scheduleTrigger(), roomUpdated))(event);
