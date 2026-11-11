import { afterEach, describe, expect, it, vi } from "vitest";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { enqueuePush } from "./enqueue.js";
import type { PushJob } from "./types.js";

Object.assign(process.env, { AWS_REGION: "us-east-1" });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PUSH_FN_NAME;
});

const job: PushJob = { kind: "run", roomId: "R", threadId: "T", number: 7, status: "done", userIds: ["u1"] };

describe("enqueuePush", () => {
  it("invokes the push worker asynchronously, without waiting for delivery", async () => {
    process.env.PUSH_FN_NAME = "cl-local-push";
    const send = vi.spyOn(LambdaClient.prototype, "send").mockResolvedValue({} as never);
    await enqueuePush(job);
    const { input } = send.mock.calls[0][0] as InvokeCommand;
    expect(input).toMatchObject({ FunctionName: "cl-local-push", InvocationType: "Event" });
    expect(JSON.parse(new TextDecoder().decode(input.Payload as Uint8Array))).toEqual(job);
  });

  it("does nothing where push isn't wired up, or when nobody is to be told", async () => {
    const send = vi.spyOn(LambdaClient.prototype, "send").mockResolvedValue({} as never);
    await enqueuePush(job);
    process.env.PUSH_FN_NAME = "cl-local-push";
    await enqueuePush({ ...job, userIds: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("never fails its caller", async () => {
    process.env.PUSH_FN_NAME = "cl-local-push";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(LambdaClient.prototype, "send").mockRejectedValue(new Error("throttled") as never);
    await expect(enqueuePush(job)).resolves.toBeUndefined();
  });
});
