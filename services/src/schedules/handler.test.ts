import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db.js";
import type { Role } from "../rooms/access.js";
import { makeHandler } from "./handler.js";

Object.assign(process.env, { TABLE_NAME: "t", AWS_REGION: "us-east-1" });

afterEach(() => vi.restoreAllMocks());

const daily9 = { kind: "daily", time: "09:00" };
const schedule = (scheduleId: string, enabled: boolean) => ({
  pk: "ROOM#r", sk: `SCHED#${scheduleId}`, scheduleId, agentId: "agent", title: scheduleId, prompt: "Go.", cadence: daily9, chatId: "c1",
  enabled, createdBy: "u1", createdByName: "aman", createdAt: scheduleId,
});

/** The room as the caller with `role` sees it: three schedules by the caller, two of them on, in Asia/Kolkata. */
function fakeTable(role: Role) {
  return vi.spyOn(docClient(), "send").mockImplementation((async (c: unknown) => {
    if (c instanceof GetCommand) {
      const sk = String(c.input.Key?.sk);
      if (sk.startsWith("MEMBER#")) return { Item: { role } };
      if (sk.startsWith("SCHED#")) return { Item: schedule(sk.slice("SCHED#".length), false) };
      return {};
    }
    if (c instanceof QueryCommand) {
      const values = JSON.stringify(c.input.ExpressionAttributeValues);
      return { Items: values.includes("SCHED#") ? [schedule("s1", true), schedule("s2", false), schedule("s3", true)] : [] };
    }
    return {};
  }) as never);
}

const ev = (routeKey: string, body?: unknown, params: Record<string, string> = {}) => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r", ...params },
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

async function call(role: Role, routeKey: string, body?: unknown, params?: Record<string, string>, putFails = false) {
  const send = fakeTable(role);
  const trigger = {
    put: vi.fn(async (_roomId: string, _s: { scheduleId: string }, _tz: string) => {
      if (putFails) throw new Error("Scheduler is down");
    }),
    remove: vi.fn(async (_scheduleId: string) => {}),
  };
  const notify = vi.fn(async (_roomId: string) => {});
  const res = await makeHandler(trigger, notify)(ev(routeKey, body, params));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body as string) : undefined, send, trigger, notify };
}

const updates = (send: ReturnType<typeof fakeTable>) => send.mock.calls.map(([c]) => c).filter((c) => c instanceof UpdateCommand);
const input = { agentId: "agent", title: "Morning digest", prompt: "Digest the new issues.", cadence: daily9, chatId: "c1" };

describe("schedules routes", () => {
  it("POST writes the schedule, then its trigger in the room's zone: 201", async () => {
    const res = await call("member", "POST /rooms/{roomId}/schedules", input);
    expect(res.status).toBe(201);
    expect(res.body.schedule).toMatchObject({ ...input, enabled: true });
    expect(res.trigger.put).toHaveBeenCalledWith("r", expect.objectContaining({ scheduleId: res.body.schedule.scheduleId }), "Asia/Kolkata");
  });

  it("a trigger Scheduler refuses switches the schedule back off: 503", async () => {
    const res = await call("member", "POST /rooms/{roomId}/schedules", input, {}, true);
    expect(res).toMatchObject({ status: 503, body: { error: "Couldn't turn the schedule on; try again." } });
    const [off] = updates(res.send);
    expect(off?.input).toMatchObject({ ExpressionAttributeNames: { "#f": "enabled" }, ExpressionAttributeValues: { ":v": false } });
  });

  it("PATCH enabled on puts the trigger and answers with the schedule; off removes it", async () => {
    const on = await call("member", "PATCH /rooms/{roomId}/schedules/{scheduleId}", { enabled: true }, { scheduleId: "s2" });
    expect(on).toMatchObject({ status: 200, body: { schedule: { scheduleId: "s2", enabled: true } } });
    expect(on.trigger.put).toHaveBeenCalledOnce();
    const off = await call("member", "PATCH /rooms/{roomId}/schedules/{scheduleId}", { enabled: false }, { scheduleId: "s2" });
    expect(off.trigger.remove).toHaveBeenCalledWith("s2");
    expect(off.trigger.put).not.toHaveBeenCalled();
  });

  it("PATCH of the title alone leaves the trigger be", async () => {
    const res = await call("member", "PATCH /rooms/{roomId}/schedules/{scheduleId}", { title: "Evening digest" }, { scheduleId: "s2" });
    expect(res.status).toBe(200);
    expect(res.trigger.put).not.toHaveBeenCalled();
    expect(res.trigger.remove).not.toHaveBeenCalled();
  });

  it("DELETE removes the item, then the trigger: 204", async () => {
    const res = await call("member", "DELETE /rooms/{roomId}/schedules/{scheduleId}", {}, { scheduleId: "s1" });
    expect(res.status).toBe(204);
    expect(res.trigger.remove).toHaveBeenCalledWith("s1");
  });

  it("GET answers with the schedules, the zone and the cap", async () => {
    const res = await call("member", "GET /rooms/{roomId}/schedules");
    expect(res.body).toMatchObject({ timeZone: "Asia/Kolkata", max: 5 });
    expect(res.body.schedules.map((s: { scheduleId: string }) => s.scheduleId)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("PUT timezone", () => {
  it("a member can't set it", async () => {
    const res = await call("member", "PUT /rooms/{roomId}/timezone", { timeZone: "Europe/London" });
    expect(res).toMatchObject({ status: 403, body: { error: "Only admins can set the room's time zone." } });
    expect(res.trigger.put).not.toHaveBeenCalled();
    expect(res.notify).not.toHaveBeenCalled();
  });

  it("an admin's change moves the enabled schedules' triggers to the new zone, and only theirs", async () => {
    const res = await call("admin", "PUT /rooms/{roomId}/timezone", { timeZone: "Europe/London" });
    expect(res).toMatchObject({ status: 200, body: { timeZone: "Europe/London" } });
    expect(res.trigger.put.mock.calls.map(([, s, tz]) => [s.scheduleId, tz])).toEqual([["s1", "Europe/London"], ["s3", "Europe/London"]]);
  });

  it("the room hears room.updated, so its view shows the new zone", async () => {
    const res = await call("admin", "PUT /rooms/{roomId}/timezone", { timeZone: "Europe/London" });
    expect(res.notify).toHaveBeenCalledWith("r");
  });
});
