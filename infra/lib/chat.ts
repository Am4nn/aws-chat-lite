import type { CoreStack } from "./core-stack.js";

/** Socket tickets and message history: one Lambda behind the HTTP API's JWT authorizer. */
export function addChat(stack: CoreStack) {
  const fn = stack.addFunction("chat", "chat/handler.ts", { tableAccess: true });
  fn.addEnvironment("WS_URL", stack.wsUrl);
  stack.route("POST", "/ws/ticket", fn);
  stack.route("GET", "/rooms/{roomId}/chats/{chatId}/messages", fn);
}
