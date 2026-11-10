import type { CoreStack } from "./core-stack.js";

/** Agent threads and the room's agent budget: one Lambda behind the HTTP API's JWT authorizer. */
export function addThreads(stack: CoreStack) {
  const fn = stack.addFunction("threads", "threads/handler.ts", { tableAccess: true });
  stack.route("POST", "/rooms/{roomId}/threads", fn);
  stack.route("PATCH", "/rooms/{roomId}/threads/{threadId}", fn);
  stack.route("PUT", "/rooms/{roomId}/budget", fn);
  return fn;
}
