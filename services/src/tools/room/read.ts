import { agentOrDefault } from "../../agents/model.js";
import { transcriptLine } from "../../chat/model.js";
import { chatRepo } from "../../chat/repo.js";
import { searchMessages } from "../../chat/search.js";
import { findChat } from "../../mcp/server/refs.js";
import { text, whole } from "../../mcp/server/tools.js";
import { mergeTaint, privateOf } from "../../models/privacy.js";
import { roomDirectory } from "../../rooms/repo.js";
import { threadsRepo } from "../../threads/repo.js";
import type { ThreadSummary } from "../../threads/types.js";
import { answer } from "../answer.js";
import type { Tool, ToolEnv } from "../types.js";

const LIST_TOOL = "room_list";
const MAX_THREADS = 50;
const NO_INPUT = { type: "object", properties: {} };

const archived = (item: { archived: boolean }) => (item.archived ? " · archived" : "");

/**
 * A thread's private content comes along with what is read from it, so the reading thread takes that thread's
 * private taint: models kept from private content stay off it, and its outbound calls ask first. The room taint is
 * not copied, since the run marks the reading thread with it before any room read.
 */
async function copyTaint(env: ToolEnv, threads: ThreadSummary[]) {
  const taint = privateOf(mergeTaint(...threads.map((t) => t.taint)));
  if (taint.length) await threadsRepo().addTaint(env.room.roomId, env.room.threadNumber, taint);
}

/**
 * The room the run works in, read without a member check: the room comes from the run, never from the model's input.
 * Only messages and answers are read, never a thread's step logs.
 */
export const ROOM_READ_TOOLS: Tool[] = [
  {
    spec: {
      name: "room_list",
      description: `List this room's people chats and its ${MAX_THREADS} newest agent threads, with each thread's number, agent, `
        + "status and last activity.",
      inputSchema: NO_INPUT,
    },
    kind: "room_read",
    write: false,
    detail: () => "The room's chats and threads",
    run: (_input, env) => answer(async () => {
      const { chats, threads, agents } = await roomDirectory(env.room.roomId);
      const agentsById = new Map(agents.map((a) => [a.agentId, a]));
      const newest = [...threads].sort((a, b) => b.number - a.number).slice(0, MAX_THREADS);
      const agentOf = (t: ThreadSummary) => agentOrDefault(agentsById.get(t.agentId)).name;
      return [
        "Chats:", ...chats.map((c) => `#${c.name}${archived(c)}`),
        "Threads:", ...newest.map((t) => `#${t.number} ${t.name} · @${agentOf(t)} · ${t.status} · ${t.lastActivityAt}${archived(t)}`),
      ].join("\n");
    }),
  },
  {
    spec: {
      name: "room_read",
      description: "Read recent messages in one of this room's people chats or agent threads: what people wrote and the "
        + "agents' answers.",
      inputSchema: {
        type: "object",
        properties: {
          chat: { type: "string", description: "A chat name, a thread tag like #12, a thread name, or an id." },
          before: { type: "integer", minimum: 1, description: "Only messages before this message number." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        },
        required: ["chat"],
      },
    },
    kind: "room_read",
    write: false,
    detail: (input) => String(input.chat ?? ""),
    run: (input, env) => answer(async () => {
      const before = whole(input, "before", 1, Number.MAX_SAFE_INTEGER);
      const limit = whole(input, "limit", 1, 100) ?? 30;
      const directory = await roomDirectory(env.room.roomId);
      const chat = findChat(directory, text(input, "chat"), LIST_TOOL);
      const { messages } = await chatRepo().roomHistory(env.room.roomId, chat.chatId, { ...(before && { before }), limit });
      await copyTaint(env, directory.threads.filter((t) => t.threadId === chat.chatId));
      return [`${directory.room.name} · #${chat.name}`, ...messages.map(transcriptLine)].join("\n");
    }),
  },
  {
    spec: {
      name: "room_search",
      description: "Search this room's chats and threads for a keyword: the 30 newest matching messages, each with the "
        + "chat or thread it is in.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    kind: "room_read",
    write: false,
    detail: (input) => String(input.query ?? ""),
    run: (input, env) => answer(async () => {
      const query = text(input, "query");
      const [{ chats, threads }, { results }] = await Promise.all([roomDirectory(env.room.roomId), searchMessages(env.room.roomId, query)]);
      const threadsById = new Map(threads.map((t) => [t.threadId, t]));
      const chatNames = new Map(chats.map((c) => [c.chatId, c.name]));
      await copyTaint(env, threads.filter((t) => results.some((m) => m.chatId === t.threadId)));
      const where = (chatId: string) => {
        const thread = threadsById.get(chatId);
        return thread ? `#${thread.number}` : `#${chatNames.get(chatId) ?? chatId}`;
      };
      return results.map((m) => `${where(m.chatId)} · ${transcriptLine(m)}`).join("\n") || `No messages match "${query}".`;
    }),
  },
  {
    spec: { name: "room_members", description: "List this room's members by username, with their roles.", inputSchema: NO_INPUT },
    kind: "room_read",
    write: false,
    detail: () => "The room's members",
    run: (_input, env) => answer(async () => {
      const { members } = await roomDirectory(env.room.roomId);
      return members.map((m) => `${m.username} · ${m.role}`).join("\n");
    }),
  },
];
