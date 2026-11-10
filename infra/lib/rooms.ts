import type { CoreStack } from "./core-stack.js";

/** Rooms, chats, members and invite links: one Lambda behind the HTTP API (JWT on all but the invite preview). */
export function addRooms(stack: CoreStack) {
  const fn = stack.addFunction("rooms", "rooms/handler.ts");
  stack.route("GET", "/me", fn);
  stack.route("GET", "/rooms", fn);
  stack.route("POST", "/rooms", fn);
  stack.route("GET", "/rooms/{roomId}", fn);
  stack.route("POST", "/rooms/{roomId}/chats", fn);
  stack.route("PATCH", "/rooms/{roomId}/members/{userId}", fn);
  stack.route("DELETE", "/rooms/{roomId}/members/{userId}", fn);
  stack.route("POST", "/rooms/{roomId}/invite", fn);
  stack.route("GET", "/rooms/{roomId}/invite", fn);
  stack.route("DELETE", "/rooms/{roomId}/invite", fn);
  stack.route("GET", "/invites/{code}", fn, { public: true }); // The invite page shows the room before sign-in.
  stack.route("POST", "/invites/{code}/accept", fn);
}
