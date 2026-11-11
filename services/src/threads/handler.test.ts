import { describe, it, expect, vi } from "vitest";
import { Conflict, NotFound } from "../lib/errors.js";
import { makeHandler } from "./handler.js";

const ev = (routeKey: string, o: { body?: unknown; params?: Record<string, string> } = {}) => ({
  routeKey,
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
  pathParameters: o.params ?? {},
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

function setup() {
  const repos = {
    threads: {
      createThread: vi.fn(async () => ({ thread: { threadId: "t1", status: "idle" }, message: { seq: 1 } })),
      rename: vi.fn(async () => ({})),
      threadById: vi.fn(async () => ({ threadId: "t1", status: "running" })),
    },
    budget: { setCap: vi.fn(async () => ({})) },
    startRun: vi.fn(async () => ({ runId: "run1", started: true })),
    issueTicket: vi.fn(async () => ({ ticket: "tk" })),
  };
  return { ...repos, handle: makeHandler(repos.threads as any, repos.budget as any, repos.startRun, repos.issueTicket) };
}

const me = { userId: "u1", username: "aman" };

describe("threads handler", () => {
  it("POST /threads creates a thread, starts a run on its first message and returns the running thread: 201", async () => {
    const { threads, startRun, handle } = setup();
    const res = await handle(ev("POST /rooms/{roomId}/threads", { params: { roomId: "r" }, body: { text: "hi", clientId: "k1" } }));
    expect(res.statusCode).toBe(201);
    expect(threads.createThread).toHaveBeenCalledWith(me, "r", { text: "hi", clientId: "k1" });
    expect(startRun).toHaveBeenCalledWith(me, "r", "t1", { seq: 1 });
    expect(JSON.parse(res.body as string)).toEqual({ thread: { threadId: "t1", status: "running" }, message: { seq: 1 } });
  });

  it("POST /threads without a valid clientId is a 400", async () => {
    const { threads, handle } = setup();
    const res = await handle(ev("POST /rooms/{roomId}/threads", { params: { roomId: "r" }, body: { text: "hi", clientId: "a b" } }));
    expect(res.statusCode).toBe(400);
    expect(threads.createThread).not.toHaveBeenCalled();
  });

  it("PATCH a thread's name: a bad name is a 400, a good one is passed on normalized", async () => {
    const { threads, handle } = setup();
    const patch = (name: unknown) => handle(ev("PATCH /rooms/{roomId}/threads/{threadId}", { params: { roomId: "r", threadId: "t" }, body: { name } }));
    expect((await patch("12")).statusCode).toBe(400);
    expect((await patch("thread-9")).statusCode).toBe(400);
    expect(threads.rename).not.toHaveBeenCalled();
    expect((await patch(" PR-Check ")).statusCode).toBe(200);
    expect(threads.rename).toHaveBeenCalledWith(me, "r", "t", "pr-check");
  });

  it("a taken name is a 409", async () => {
    const { threads, handle } = setup();
    threads.rename.mockRejectedValueOnce(new Conflict("#pr-check is taken."));
    const res = await handle(ev("PATCH /rooms/{roomId}/threads/{threadId}", { params: { roomId: "r", threadId: "t" }, body: { name: "pr-check" } }));
    expect(res.statusCode).toBe(409);
  });

  it("PUT /budget: a bad cap is a 400, a good one is passed on in micro-dollars", async () => {
    const { budget, handle } = setup();
    const put = (capUsd: unknown) => handle(ev("PUT /rooms/{roomId}/budget", { params: { roomId: "r" }, body: { capUsd } }));
    expect((await put("x")).statusCode).toBe(400);
    expect(budget.setCap).not.toHaveBeenCalled();
    expect((await put(5)).statusCode).toBe(200);
    expect(budget.setCap).toHaveBeenCalledWith(me, "r", 5_000_000);
  });

  it("POST /runs/{runId}/stream-ticket answers the stream URL with a fresh ticket", async () => {
    process.env.STREAM_URL = "https://abc.lambda-url.ap-southeast-2.on.aws/";
    const { issueTicket, handle } = setup();
    const res = await handle(ev("POST /runs/{runId}/stream-ticket", { params: { runId: "run1" }, body: {} }));
    expect(res.statusCode).toBe(200);
    expect(issueTicket).toHaveBeenCalledWith(me, "run1");
    expect(JSON.parse(res.body as string)).toEqual({ url: "https://abc.lambda-url.ap-southeast-2.on.aws/runs/run1/stream?ticket=tk" });
  });

  it("a stream ticket for a run outside your rooms is a 404", async () => {
    const { issueTicket, handle } = setup();
    issueTicket.mockRejectedValueOnce(new NotFound("Room not found."));
    expect((await handle(ev("POST /runs/{runId}/stream-ticket", { params: { runId: "run1" } }))).statusCode).toBe(404);
  });

  it("an unknown route is a 404", async () => {
    expect((await setup().handle(ev("DELETE /rooms/{roomId}/threads/{threadId}"))).statusCode).toBe(404);
  });
});
