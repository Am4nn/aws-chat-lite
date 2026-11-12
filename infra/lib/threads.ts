import type { CoreStack } from "./core-stack.js";

/**
 * Agent threads, the room's agent budget, run-stream tickets and approval decisions: one Lambda behind the HTTP API's
 * JWT authorizer. A message posted in a thread starts or steers its run, a decision wakes the run waiting on it, and a
 * mention queues a push. Each stream ticket is a link on `streamUrl`.
 */
export function addThreads(stack: CoreStack, streamUrl: string) {
  const fn = stack.addFunction("threads", "threads/handler.ts", { tableAccess: true, environment: { STREAM_URL: streamUrl } });
  stack.allowBroadcast(fn);
  stack.allowRunStart(fn);
  stack.allowRunCallback(fn);
  stack.allowPush(fn);
  stack.route("POST", "/rooms/{roomId}/threads", fn);
  stack.route("PATCH", "/rooms/{roomId}/threads/{threadId}", fn);
  stack.route("PUT", "/rooms/{roomId}/budget", fn);
  stack.route("POST", "/runs/{runId}/stream-ticket", fn);
  stack.route("POST", "/runs/{runId}/approvals/{step}", fn);
}
