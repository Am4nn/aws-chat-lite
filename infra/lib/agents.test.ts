import { describe, it, expect } from "vitest";
import { fnNamed, jwtRoutesOf, statementsOf } from "./test-templates.js";

const ROUTES = [
  "GET /rooms/{roomId}/agents", "POST /rooms/{roomId}/agents", "PATCH /rooms/{roomId}/agents/{agentId}",
  "DELETE /rooms/{roomId}/agents/{agentId}", "POST /rooms/{roomId}/agents/{agentId}/copy",
  "GET /rooms/{roomId}/memory", "PATCH /rooms/{roomId}/memory/{memoryId}", "DELETE /rooms/{roomId}/memory/{memoryId}",
];

describe("agents API", () => {
  it("one Lambda serves the agents and memory routes, behind the JWT authorizer", () => {
    expect(jwtRoutesOf(fnNamed("cl-local-agents").logicalId).sort()).toEqual([...ROUTES].sort());
  });

  it("may tell the room, and on Scheduler only delete schedules in the room schedules' group", () => {
    const fn = fnNamed("cl-local-agents");
    expect(fn.props.Timeout).toBe(10);
    expect(fn.props.Environment.Variables).toMatchObject({ SCHEDULE_GROUP: "cl-local-agent-schedules" });
    expect(fn.props.Environment.Variables.WS_CALLBACK_URL).toBeDefined();
    const scheduler = statementsOf(fn).filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith("scheduler:")));
    expect(scheduler).toHaveLength(1);
    expect(scheduler[0].Action).toBe("scheduler:DeleteSchedule");
    expect(JSON.stringify(scheduler[0].Resource)).toMatch(/:schedule\/cl-local-agent-schedules\/\*"\]\]\}$/);
  });
});
