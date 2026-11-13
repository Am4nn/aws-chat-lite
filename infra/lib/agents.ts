import type { CoreStack } from "./core-stack.js";
import { allowSchedules } from "./schedules.js";

/**
 * A room's agents and memory: one Lambda behind the HTTP API's JWT authorizer. Deleting an agent deletes its
 * schedules, so it may delete their EventBridge schedules too, and nothing else on Scheduler. It looks users up, as no
 * agent may take a person's name.
 */
export function addAgents(stack: CoreStack, schedules: { groupName: string }) {
  const fn = stack.addFunction("agents", "agents/handler.ts", { tableAccess: true });
  stack.allowUserLookup(fn);
  allowSchedules(stack, fn, schedules.groupName, ["DeleteSchedule"]);
  stack.allowBroadcast(fn);
  stack.route("GET", "/rooms/{roomId}/agents", fn);
  stack.route("POST", "/rooms/{roomId}/agents", fn);
  stack.route("PATCH", "/rooms/{roomId}/agents/{agentId}", fn);
  stack.route("DELETE", "/rooms/{roomId}/agents/{agentId}", fn);
  stack.route("POST", "/rooms/{roomId}/agents/{agentId}/copy", fn);
  stack.route("GET", "/rooms/{roomId}/memory", fn);
  stack.route("PATCH", "/rooms/{roomId}/memory/{memoryId}", fn);
  stack.route("DELETE", "/rooms/{roomId}/memory/{memoryId}", fn);
}
