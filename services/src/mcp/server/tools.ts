import { randomUUID } from "node:crypto";
import type { User } from "../../lib/auth.js";
import { UserError, ValidationError } from "../../lib/errors.js";
import type { Message } from "../../chat/model.js";
import type { ChatRepo } from "../../chat/repo.js";
import type { broadcastToRoom } from "../../live/broadcast.js";
import type { RoomsRepo } from "../../rooms/repo.js";
import type { routeSend } from "../../threads/route.js";
import type { startThread } from "../../threads/start-thread.js";
import type { Scope } from "../../threads/types.js";
import { findChat, findRoom } from "./refs.js";

export interface ServerDeps {
  rooms: Pick<RoomsRepo, "listMyRooms" | "getRoomView">;
  history: ChatRepo["history"];
  send: typeof routeSend;
  broadcast: typeof broadcastToRoom;
  startThread: typeof startThread;
  siteUrl: string;
}

type Input = Record<string, unknown>;

interface ServerTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint?: false; idempotentHint?: boolean; openWorldHint: false };
  scope: Scope;
  /** Rejects only with a `UserError`, whose message is written for the person behind the MCP client. */
  run(user: User, input: Input, deps: ServerDeps): Promise<string>;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ROOM = { type: "string", description: "A room's id or name." };
const CHAT = { type: "string", description: "A chat name, a thread tag like #12, or an id." };

// The SDK's low-level server doesn't check arguments against the input schema, so each tool checks its own.
function text(input: Input, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${key} must be a non-empty string.`);
  return value;
}

function whole(input: Input, key: string, min: number, max: number): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

async function myRoom(user: User, input: Input, deps: ServerDeps) {
  return findRoom(await deps.rooms.listMyRooms(user.userId), text(input, "room"));
}

/** The view checks membership with a strongly consistent read, so someone removed from a room is refused at once. */
async function myRoomView(user: User, input: Input, deps: ServerDeps) {
  return deps.rooms.getRoomView((await myRoom(user, input, deps)).roomId, user.userId);
}

async function roomAndChat(user: User, input: Input, deps: ServerDeps) {
  const view = await myRoomView(user, input, deps);
  return { view, chat: findChat(view, text(input, "chat")) };
}

// A tab settles its pending send by client id. An MCP post has no tab waiting on it, so any fresh id does; the prefix
// shows in the stored message where it came from.
const clientId = () => `mcp-${randomUUID()}`;

function line(m: Message): string {
  const files = m.attachments.length ? ` [${m.attachments.length} file${m.attachments.length === 1 ? "" : "s"}]` : "";
  return `[${m.seq}] ${m.authorName} · ${m.createdAt}: ${m.deleted ? "(deleted)" : m.text}${files}`;
}

const TOOLS: ServerTool[] = [
  {
    name: "list_rooms", title: "List rooms", description: "List the chat-lite rooms you belong to.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: READ, scope: "rooms:read",
    async run(user, _input, deps) {
      const rooms = await deps.rooms.listMyRooms(user.userId);
      return rooms.map((r) => `${r.name} · ${r.role} · id ${r.roomId}`).join("\n") || "You aren't in any rooms yet.";
    },
  },
  {
    name: "list_room", title: "List a room", description: "List a room's people chats and its recent agent threads.",
    inputSchema: { type: "object", properties: { room: ROOM }, required: ["room"], additionalProperties: false },
    annotations: READ, scope: "rooms:read",
    async run(user, input, deps) {
      const view = await myRoomView(user, input, deps);
      const threads = view.threads.filter((t) => !t.archived).sort((a, b) => b.number - a.number).slice(0, 20);
      return [
        "Chats:", ...view.chats.map((c) => `#${c.name} (${c.unread} unread)${c.archived ? " · archived, read-only" : ""}`),
        "Threads:", ...threads.map((t) => `#${t.number} ${t.name} · ${t.status}`),
      ].join("\n");
    },
  },
  {
    name: "read_messages", title: "Read messages",
    description: "Read recent messages in a people chat or an agent thread. `chat` is a chat name, a thread tag like #12 or #pr-check, or an id.",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM, chat: CHAT,
        before: { type: "integer", minimum: 1, description: "Only messages before this message number." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["room", "chat"], additionalProperties: false,
    },
    annotations: READ, scope: "rooms:read",
    async run(user, input, deps) {
      const before = whole(input, "before", 1, Number.MAX_SAFE_INTEGER);
      const limit = whole(input, "limit", 1, 100) ?? 30;
      const { view, chat } = await roomAndChat(user, input, deps);
      const { messages } = await deps.history(user, view.room.roomId, chat.chatId, { ...(before && { before }), limit });
      return [`${view.room.name} · #${chat.name}`, ...messages.map(line)].join("\n");
    },
  },
  {
    name: "post_message", title: "Post a message",
    description: "Post a message as you. In a people chat, @agent starts an agent thread; in a thread, it goes to that thread's agent.",
    inputSchema: { type: "object", properties: { room: ROOM, chat: CHAT, text: { type: "string" } }, required: ["room", "chat", "text"], additionalProperties: false },
    annotations: WRITE, scope: "rooms:write",
    async run(user, input, deps) {
      const body = text(input, "text");
      const { view, chat } = await roomAndChat(user, input, deps);
      const { message, route } = await deps.send(user, { roomId: view.room.roomId, chatId: chat.chatId, clientId: clientId(), text: body });
      // A Lambda is frozen once it answers, so the fan-out and the hand-off to the agent finish first.
      await deps.broadcast(view.room.roomId, { type: "message.new", message });
      await route();
      return `Posted to #${chat.name} in ${view.room.name} (message ${message.seq}).`;
    },
  },
  {
    name: "start_thread", title: "Start a thread", description: "Start a new agent thread in a room with this message.",
    inputSchema: { type: "object", properties: { room: ROOM, text: { type: "string" } }, required: ["room", "text"], additionalProperties: false },
    annotations: WRITE, scope: "rooms:write",
    async run(user, input, deps) {
      const body = text(input, "text");
      const room = await myRoom(user, input, deps);
      const { thread } = await deps.startThread(user, room.roomId, { text: body, clientId: clientId() });
      return `Started #${thread.number} in ${room.name}: ${deps.siteUrl}/r/${room.roomId}/t/${thread.number}`;
    },
  },
];

/** A refusal reaches the client as written; anything else is a bug, logged here and never shown. */
export const SERVER_TOOLS: ServerTool[] = TOOLS.map((tool) => ({
  ...tool,
  async run(user, input, deps) {
    try {
      return await tool.run(user, input, deps);
    } catch (e) {
      if (e instanceof UserError) throw e;
      console.error("MCP tool failed", tool.name, e);
      throw new UserError("Something went wrong.");
    }
  },
}));

export const toolsForScopes = (scopes: Scope[]) => SERVER_TOOLS.filter((t) => scopes.includes(t.scope));
